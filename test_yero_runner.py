import base64
import importlib.util
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from unittest import mock

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from websockets.sync.server import serve
from test_yero_relay import FakeBridge, PNG

KEY = bytes.fromhex('01' * 32)
JOB_ID = 'a' * 32


def seal(value):
    nonce = bytes(range(12))
    return nonce + AESGCM(KEY).encrypt(nonce, json.dumps(value).encode(), None)


class FakeCloud(BaseHTTPRequestHandler):
    queued = seal({'prompt': 'A blue bird', 'ratio': '1:1', 'style': '自动', 'reference': None})
    result = None
    reads = 0
    not_ready = 0

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.__class__.reads += 1
        if self.headers.get('X-Yero-Runner') != 'runner-key':
            self.send_error(401)
            return
        if not self.headers.get('User-Agent', '').startswith('Mozilla/'):
            self.send_error(403)
            return
        if urlsplit(self.path).path != '/api/runner/job/' + JOB_ID or urlsplit(self.path).query != 'kind=image':
            self.send_error(404)
            return
        if self.__class__.not_ready:
            self.__class__.not_ready -= 1
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(self.queued)))
        self.end_headers()
        self.wfile.write(self.queued)

    def do_POST(self):
        if self.headers.get('X-Yero-Runner') != 'runner-key' or self.path != '/api/runner/result/' + JOB_ID:
            self.send_error(401)
            return
        encrypted = self.rfile.read(int(self.headers['Content-Length']))
        self.__class__.result = json.loads(AESGCM(KEY).decrypt(encrypted[:12], encrypted[12:], None))
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()


class RunnerAvailability(unittest.TestCase):
    def test_outbound_runner_is_available(self):
        self.assertIsNotNone(importlib.util.find_spec('yero_runner'), 'Outbound runner has not been implemented')


class RunnerIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec('yero_runner') is None:
            raise unittest.SkipTest('Outbound runner is not available yet')
        import yero_runner
        cls.runner_module = yero_runner
        cls.bridge = ThreadingHTTPServer(('127.0.0.1', 0), FakeBridge)
        cls.cloud = ThreadingHTTPServer(('127.0.0.1', 0), FakeCloud)
        for server in (cls.bridge, cls.cloud):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.bridge, cls.cloud):
            server.shutdown()
            server.server_close()

    def test_runner_pulls_encrypted_job_and_returns_image_without_repeating_it(self):
        FakeBridge.paths.clear()
        FakeCloud.result = None
        FakeCloud.reads = 0
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner_module.Runner(
                'http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key', Path(folder))
            self.assertEqual(FakeCloud.reads, 0, 'idle startup does not read the queue')
            self.assertTrue(runner.run_job(JOB_ID))
            self.assertEqual(FakeCloud.result['status'], 'completed')
            self.assertEqual(FakeCloud.result['image'], 'data:image/png;base64,' + base64.b64encode(PNG).decode())
            self.assertEqual(FakeBridge.paths, ['/v1/images/generations'])
            self.assertFalse(runner.run_job(JOB_ID))
            self.assertEqual(FakeCloud.reads, 1)
            self.assertEqual(FakeBridge.paths, ['/v1/images/generations'])

    def test_interrupted_generation_is_not_started_again(self):
        FakeBridge.paths.clear()
        FakeCloud.result = None
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, JOB_ID + '.processing').write_text('', encoding='utf-8')
            runner = self.runner_module.Runner(
                'http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key', Path(folder))
            self.assertTrue(runner.run_job(JOB_ID))
            self.assertEqual(FakeCloud.result['status'], 'failed')
            self.assertEqual(FakeBridge.paths, [])

    def test_large_encrypted_edit_payload_is_not_truncated(self):
        original = FakeCloud.queued
        FakeCloud.queued = seal({'prompt': 'Change this area', 'reference': 'A' * (21 * 1024 * 1024)})
        FakeCloud.result = None
        try:
            with tempfile.TemporaryDirectory() as folder:
                runner = self.runner_module.Runner(
                    'http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                    'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key', Path(folder))
                with mock.patch.object(runner, 'process_payload', return_value={'status': 'completed', 'image': 'ok'}) as process:
                    self.assertTrue(runner.run_job(JOB_ID))
                self.assertEqual(FakeCloud.result['status'], 'completed')
                self.assertEqual(len(process.call_args.args[0]['reference']), 21 * 1024 * 1024)
        finally:
            FakeCloud.queued = original

    def test_new_job_retries_only_its_own_temporarily_unavailable_payload(self):
        FakeCloud.not_ready, FakeCloud.reads, FakeCloud.result = 6, 0, None
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner_module.Runner(
                'http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key', Path(folder))
            with mock.patch('yero_runner.time.sleep'):
                self.assertTrue(runner.run_job(JOB_ID))
            self.assertEqual(FakeCloud.reads, 7)
            self.assertEqual(FakeCloud.result['status'], 'completed')

    def test_missing_payload_fails_without_generation_or_endless_retries(self):
        FakeCloud.not_ready, FakeCloud.reads, FakeCloud.result = 7, 0, None
        FakeBridge.paths.clear()
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner_module.Runner(
                'http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key', Path(folder))
            with mock.patch('yero_runner.time.sleep'):
                self.assertTrue(runner.run_job(JOB_ID))
            self.assertEqual(FakeCloud.reads, 7)
            self.assertEqual(FakeCloud.result['status'], 'failed')
            self.assertEqual(FakeBridge.paths, [])

    def test_websocket_waits_without_polling_and_dispatches_a_real_notification(self):
        connected, release, delivered = threading.Event(), threading.Event(), threading.Event()
        captured = {}

        def handler(socket):
            captured['key'] = socket.request.headers.get('X-Yero-Runner')
            connected.set()
            if release.wait(5):
                socket.send(json.dumps({'id': JOB_ID, 'kind': 'image'}))
                delivered.wait(5)

        class StopWatch(BaseException):
            pass

        with serve(handler, '127.0.0.1', 0) as server, tempfile.TemporaryDirectory() as folder:
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            runner = self.runner_module.Runner('http://127.0.0.1:%d' % server.socket.getsockname()[1],
                                                'runner-key', KEY, '', '', Path(folder))
            class CountHttp:
                calls = 0
                def open(self, *args, **kwargs):
                    self.calls += 1
                    raise AssertionError('unexpected idle HTTP request')
            runner.cloud = CountHttp()
            def handle(job_id):
                captured['id'] = job_id
                delivered.set()
                raise StopWatch()
            runner.run_job = handle
            def watch():
                try:
                    runner.watch()
                except StopWatch:
                    pass
            thread = threading.Thread(target=watch, daemon=True)
            thread.start()
            try:
                self.assertTrue(connected.wait(5), 'runner connected over WebSocket')
                self.assertEqual(captured['key'], 'runner-key')
                time.sleep(.25)
                self.assertEqual(runner.cloud.calls, 0, 'no queue requests are made while idle')
                release.set()
                self.assertTrue(delivered.wait(5), 'notification was dispatched')
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(captured['id'], JOB_ID)
            finally:
                release.set()
                delivered.set()
                server.shutdown()
                server_thread.join(5)


if __name__ == '__main__':
    unittest.main()

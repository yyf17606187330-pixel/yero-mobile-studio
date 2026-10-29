import base64
import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from test_yero_relay import FakeBridge, PNG

KEY = bytes.fromhex('01' * 32)
JOB_ID = 'a' * 32


def seal(value):
    nonce = bytes(range(12))
    return nonce + AESGCM(KEY).encrypt(nonce, json.dumps(value).encode(), None)


class FakeCloud(BaseHTTPRequestHandler):
    queued = seal({'prompt': 'A blue bird', 'ratio': '1:1', 'style': '自动', 'reference': None})
    result = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get('X-Yero-Runner') != 'runner-key':
            self.send_error(401)
            return
        seen = self.headers.get('X-Yero-Seen', '').split(',')
        if urlsplit(self.path).path != '/api/runner/next' or JOB_ID in seen:
            self.send_response(204)
            self.send_header('X-Yero-Latest', JOB_ID)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('X-Yero-Job', JOB_ID)
        self.send_header('X-Yero-Latest', JOB_ID)
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
        with tempfile.TemporaryDirectory() as folder:
            runner = self.runner_module.Runner(
                'http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key', Path(folder))
            self.assertTrue(runner.run_once(force=True))
            self.assertEqual(FakeCloud.result['status'], 'completed')
            self.assertEqual(FakeCloud.result['image'], 'data:image/png;base64,' + base64.b64encode(PNG).decode())
            self.assertEqual(FakeBridge.paths, ['/v1/images/generations'])
            self.assertFalse(runner.run_once(force=True))
            self.assertEqual(FakeBridge.paths, ['/v1/images/generations'])


if __name__ == '__main__':
    unittest.main()

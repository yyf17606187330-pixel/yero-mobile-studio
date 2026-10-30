import base64
import importlib.util
import io
import json
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from yero_relay import InputError

KEY = bytes.fromhex('02' * 32)
JOB_ID = 'b' * 32


def wav(seconds=1):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b'\x00\x00' * (16000 * seconds))
    return output.getvalue()


def payload(data=None):
    return {'audio': 'data:audio/wav;base64,' + base64.b64encode(data if data is not None else wav()).decode('ascii')}


def seal(value):
    nonce = bytes(range(12))
    return nonce + AESGCM(KEY).encrypt(nonce, json.dumps(value).encode(), None)


class FakeVoiceCloud(BaseHTTPRequestHandler):
    result = None
    received_paths = []
    queued = seal(payload())

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.__class__.received_paths.append(urlsplit(self.path).path)
        if self.headers.get('X-Yero-Runner') != 'runner-key':
            self.send_error(401)
            return
        if urlsplit(self.path).path != '/api/runner/voice-next' or JOB_ID in self.headers.get('X-Yero-Seen', '').split(','):
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
        self.__class__.received_paths.append(self.path)
        if self.headers.get('X-Yero-Runner') != 'runner-key' or self.path != '/api/runner/voice-result/' + JOB_ID:
            self.send_error(401)
            return
        encrypted = self.rfile.read(int(self.headers['Content-Length']))
        self.__class__.result = json.loads(AESGCM(KEY).decrypt(encrypted[:12], encrypted[12:], None))
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()


class VoiceAvailability(unittest.TestCase):
    def test_voice_bridge_is_available(self):
        self.assertIsNotNone(importlib.util.find_spec('yero_voice'), 'Voice bridge has not been implemented')


class VoiceIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec('yero_voice') is None:
            raise unittest.SkipTest('Voice bridge is not available yet')
        import yero_voice
        cls.voice = yero_voice
        cls.cloud = ThreadingHTTPServer(('127.0.0.1', 0), FakeVoiceCloud)
        threading.Thread(target=cls.cloud.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.cloud.shutdown()
        cls.cloud.server_close()

    def test_audio_validation_and_duration_limit(self):
        raw = self.voice.validate_voice_payload(payload())
        self.assertEqual(raw, wav())
        self.assertEqual(len(self.voice.decode_voice(raw)), 16000)
        for value in ({}, {'audio': 'data:text/plain;base64,AAAA'}, payload(b'not a recording')):
            with self.assertRaises(InputError):
                self.voice.validate_voice_payload(value)
        with self.assertRaises(InputError):
            self.voice.decode_voice(wav(61))

    def test_voice_runner_uses_separate_queue_and_returns_text_once(self):
        FakeVoiceCloud.result = None
        FakeVoiceCloud.received_paths.clear()
        with tempfile.TemporaryDirectory() as folder:
            runner = self.voice.VoiceRunner('http://127.0.0.1:%d' % self.cloud.server_port, 'runner-key', KEY,
                                            Path(folder), transcriber=lambda raw: '紫色海报' if raw == wav() else '')
            self.assertTrue(runner.run_once(force=True))
            self.assertEqual(FakeVoiceCloud.result, {'status': 'completed', 'text': '紫色海报'})
            self.assertFalse(runner.run_once(force=True))
            self.assertEqual(FakeVoiceCloud.received_paths,
                             ['/api/runner/voice-next', '/api/runner/voice-result/' + JOB_ID, '/api/runner/voice-next'])


if __name__ == '__main__':
    unittest.main()

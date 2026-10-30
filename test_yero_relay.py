import base64
import importlib.util
import io
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=')
DATA_URL = 'data:image/png;base64,' + base64.b64encode(PNG).decode('ascii')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class FakeBridge(BaseHTTPRequestHandler):
    paths = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = self.rfile.read(int(self.headers['Content-Length']))
        if self.headers.get('Authorization') != 'Bearer existing-bridge-key':
            self.send_error(401)
            return
        if self.path == '/v1/images/generations':
            valid = json.loads(payload).get('prompt', '').startswith('A blue bird')
        elif self.path == '/v1/images/edits':
            valid = b'name="image"' in payload and PNG in payload
        else:
            valid = False
        if not valid:
            self.send_error(400)
            return
        self.paths.append(self.path)
        data = json.dumps({'created': 1, 'data': [{'b64_json': base64.b64encode(PNG).decode('ascii')}],
                           'bridge': {'backend': 'fixture', 'format': 'png', 'job_id': 'f' * 32}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class RelayAvailability(unittest.TestCase):
    def test_relay_implementation_is_available(self):
        self.assertIsNotNone(importlib.util.find_spec('yero_relay'), 'Image-only relay has not been implemented')


class RelayIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec('yero_relay') is None:
            raise unittest.SkipTest('Relay implementation is not available yet')
        import yero_relay
        cls.bridge = ThreadingHTTPServer(('127.0.0.1', 0), FakeBridge)
        threading.Thread(target=cls.bridge.serve_forever, daemon=True).start()
        bridge_url = 'http://127.0.0.1:%d' % cls.bridge.server_port
        cls.relay = yero_relay.make_server('127.0.0.1', 0, 'separate-relay-key', bridge_url, 'existing-bridge-key')
        threading.Thread(target=cls.relay.serve_forever, daemon=True).start()
        cls.base = 'http://127.0.0.1:%d' % cls.relay.server_port

    @classmethod
    def tearDownClass(cls):
        for server in (cls.relay, cls.bridge):
            server.shutdown()
            server.server_close()

    def request(self, path, body=None, key='separate-relay-key'):
        headers = {'X-Yero-Relay': key} if key else {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body).encode()
        else:
            data = None
        req = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            with OPENER.open(req, timeout=4) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def wait_image(self, job_id):
        for _ in range(60):
            status, body = self.request('/jobs/' + job_id)
            self.assertEqual(status, 200)
            if body['status'] in ('completed', 'failed'):
                self.assertEqual(body['status'], 'completed', body)
                return body['image']
            time.sleep(.05)
        self.fail('Image job did not complete')

    def test_bridge_is_not_reachable_without_relay_key(self):
        status, _ = self.request('/jobs', {'prompt': 'A blue bird'}, key='wrong')
        self.assertEqual(status, 401)
        status, _ = self.request('/jobs/' + '0' * 32, key='')
        self.assertEqual(status, 401)

    def test_non_image_bridge_routes_are_not_exposed(self):
        status, _ = self.request('/v1/models')
        self.assertEqual(status, 404)

    def test_invalid_prompt_and_reference_are_rejected(self):
        self.assertEqual(self.request('/jobs', {'prompt': '   '})[0], 400)
        self.assertEqual(self.request('/jobs', {'prompt': 'A blue bird', 'reference': 'data:image/png;base64,not-valid!'})[0], 400)

    def test_mask_is_validated_and_forwarded_as_multipart(self):
        import yero_relay
        mask = io.BytesIO()
        Image.new('RGBA', (1, 1), (255, 255, 255, 0)).save(mask, format='PNG')
        encoded = 'data:image/png;base64,' + base64.b64encode(mask.getvalue()).decode('ascii')
        job = yero_relay.validate_job({'prompt': 'Change this area', 'reference': DATA_URL, 'mask': encoded})
        request = yero_relay.build_request(job, 'http://127.0.0.1', 'test-key')
        self.assertIn(b'name="mask"', request.data)
        self.assertIn(mask.getvalue(), request.data)
        with self.assertRaises(yero_relay.InputError):
            yero_relay.validate_job({'prompt': 'Change this area', 'mask': encoded})
        other = io.BytesIO()
        Image.new('RGBA', (2, 1), (255, 255, 255, 0)).save(other, format='PNG')
        invalid = 'data:image/png;base64,' + base64.b64encode(other.getvalue()).decode('ascii')
        with self.assertRaises(yero_relay.InputError):
            yero_relay.validate_job({'prompt': 'Change this area', 'reference': DATA_URL, 'mask': invalid})

    def test_text_generation_returns_the_generated_image(self):
        status, body = self.request('/jobs', {'prompt': 'A blue bird', 'ratio': '1:1', 'style': '自动'})
        self.assertEqual(status, 202)
        self.assertEqual(self.wait_image(body['id']), DATA_URL)
        self.assertIn('/v1/images/generations', FakeBridge.paths)

    def test_reference_image_uses_image_edit_and_returns_result(self):
        status, body = self.request('/jobs', {'prompt': 'Turn the reference blue', 'ratio': '3:4', 'style': '自动', 'reference': DATA_URL})
        self.assertEqual(status, 202)
        self.assertEqual(self.wait_image(body['id']), DATA_URL)
        self.assertIn('/v1/images/edits', FakeBridge.paths)

    def test_reference_result_uses_native_image_without_stretching_and_honors_resolution(self):
        import yero_relay
        with tempfile.TemporaryDirectory() as folder:
            native = Path(folder) / 'jobs' / ('f' * 32) / 'native-output.png'
            native.parent.mkdir(parents=True)
            Image.new('RGB', (400, 200), '#7650c0').save(native)
            for resolution, expected in [('原图', (400, 200)), ('1K', (1024, 512)),
                                         ('2K', (2048, 1024)), ('4K', (4096, 2048))]:
                with self.subTest(resolution=resolution):
                    job = yero_relay.validate_job({'prompt': 'Turn the reference blue', 'ratio': '3:4', 'style': '自动',
                                                   'resolution': resolution, 'reference': DATA_URL})
                    result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port,
                                                    'existing-bridge-key', bridge_state_dir=Path(folder))
                    self.assertEqual(result['status'], 'completed')
                    with Image.open(io.BytesIO(base64.b64decode(result['image'].split(',', 1)[1]))) as image:
                        self.assertEqual(image.size, expected)


if __name__ == '__main__':
    unittest.main()

import base64
import importlib.util
import io
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from email import policy
from email.parser import BytesParser
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=')
DATA_URL = 'data:image/png;base64,' + base64.b64encode(PNG).decode('ascii')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class FakeBridge(BaseHTTPRequestHandler):
    paths = []
    image = PNG

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
        data = json.dumps({'created': 1, 'data': [{'b64_json': base64.b64encode(self.image).decode('ascii')}],
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

    def test_brush_is_sent_as_a_semantic_guide_at_the_reference_aspect_ratio(self):
        import yero_relay
        source = io.BytesIO()
        Image.new('RGB', (400, 300), (30, 70, 110)).save(source, format='PNG')
        mask = io.BytesIO()
        marked = Image.new('RGBA', (400, 300), (255, 255, 255, 255))
        ImageDraw.Draw(marked).rectangle((180, 120, 220, 150), fill=(255, 255, 255, 0))
        marked.save(mask, format='PNG')
        reference = 'data:image/png;base64,' + base64.b64encode(source.getvalue()).decode('ascii')
        encoded = 'data:image/png;base64,' + base64.b64encode(mask.getvalue()).decode('ascii')
        job = yero_relay.validate_job({'prompt': 'Clean the glass', 'ratio': '1:1', 'reference': reference, 'mask': encoded})
        request = yero_relay.build_request(job, 'http://127.0.0.1', 'test-key')
        envelope = ('Content-Type: ' + request.get_header('Content-type') + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + request.data
        parts = list(BytesParser(policy=policy.default).parsebytes(envelope).iter_parts())
        names = [part.get_param('name', header='Content-Disposition') for part in parts]
        self.assertNotIn('mask', names, 'Brush strokes are guidance, not a hard pixel boundary')
        images = [part.get_payload(decode=True) for part in parts if part.get_param('name', header='Content-Disposition') in ('image', 'image[]')]
        self.assertEqual(len(images), 2)
        self.assertEqual(images[0], source.getvalue())
        with Image.open(io.BytesIO(images[1])) as guide:
            self.assertEqual(guide.size, (400, 300))
            self.assertEqual(guide.convert('RGB').getpixel((10, 10)), (30, 70, 110))
            self.assertNotEqual(guide.convert('RGB').getpixel((200, 130)), (30, 70, 110))
        fields = {part.get_param('name', header='Content-Disposition'): part.get_payload(decode=True).decode('utf-8') for part in parts if not part.get_filename()}
        self.assertEqual(fields['size'], '1024x768', 'Reference aspect must override the unrelated canvas setting')
        self.assertIn('Clean the glass', fields['prompt'])
        self.assertIn('大致', fields['prompt'])
        self.assertIn('完整', fields['prompt'])
        with self.assertRaises(yero_relay.InputError):
            yero_relay.validate_job({'prompt': 'Change this area', 'mask': encoded})
        other = io.BytesIO()
        Image.new('RGBA', (2, 1), (255, 255, 255, 0)).save(other, format='PNG')
        invalid = 'data:image/png;base64,' + base64.b64encode(other.getvalue()).decode('ascii')
        with self.assertRaises(yero_relay.InputError):
            yero_relay.validate_job({'prompt': 'Change this area', 'reference': reference, 'mask': invalid})
        blank = io.BytesIO()
        Image.new('RGBA', (400, 300), (255, 255, 255, 255)).save(blank, format='PNG')
        empty = 'data:image/png;base64,' + base64.b64encode(blank.getvalue()).decode('ascii')
        with self.assertRaises(yero_relay.InputError):
            yero_relay.validate_job({'prompt': 'Change this area', 'reference': reference, 'mask': empty})

    def test_accepts_generated_4k_reference_larger_than_ten_mib_with_mask(self):
        import yero_relay
        image = io.BytesIO()
        Image.new('P', (4096, 3072)).save(image, format='PNG', compress_level=0, bits=8)
        raw = image.getvalue()
        self.assertGreater(len(raw), 10 * 1024 * 1024)
        mask = io.BytesIO()
        Image.new('RGBA', (4096, 3072), (255, 255, 255, 0)).save(mask, format='PNG')
        try:
            job = yero_relay.validate_job({'prompt': 'Change this area',
                'reference': 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii'),
                'mask': 'data:image/png;base64,' + base64.b64encode(mask.getvalue()).decode('ascii')})
        except yero_relay.InputError as exc:
            self.fail('A generated 4K reference was rejected: ' + str(exc))
        self.assertEqual(job['image'], raw)
        self.assertEqual(job['mask'], mask.getvalue())
        forwarded = yero_relay.build_request(job, 'http://127.0.0.1', 'test-key')
        self.assertIn(raw, forwarded.data)
        self.assertNotIn(b'name="mask"', forwarded.data)
        self.assertIn(b'name="image[]"', forwarded.data)

    def test_large_4k_bridge_result_is_read_before_compression(self):
        import yero_relay
        image = io.BytesIO()
        Image.new('RGB', (4096, 2048), '#336699').save(image, format='PNG', compress_level=0)
        self.assertGreater(len(base64.b64encode(image.getvalue())), 30 * 1024 * 1024)
        job = yero_relay.validate_job({'prompt': 'A blue bird', 'resolution': '原图'})
        with mock.patch.object(FakeBridge, 'image', image.getvalue()):
            result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key')
        self.assertEqual(result['status'], 'completed', result)
        with Image.open(io.BytesIO(base64.b64decode(result['image'].split(',', 1)[1]))) as output:
            self.assertEqual(output.size, (4096, 2048))

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
            for resolution, expected in [('原图', (400, 200)), ('1K', (1024, 512))]:
                with self.subTest(resolution=resolution):
                    job = yero_relay.validate_job({'prompt': 'Turn the reference blue', 'ratio': '3:4', 'style': '自动',
                                                   'resolution': resolution, 'reference': DATA_URL})
                    result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port,
                                                    'existing-bridge-key', bridge_state_dir=Path(folder))
                    self.assertEqual(result['status'], 'completed')
                    with Image.open(io.BytesIO(base64.b64decode(result['image'].split(',', 1)[1]))) as image:
                        self.assertEqual(image.size, expected)

    def test_guided_edit_rejects_a_generated_image_with_the_wrong_aspect(self):
        import yero_relay
        with tempfile.TemporaryDirectory() as folder:
            native = Path(folder) / 'jobs' / ('f' * 32) / 'native-output.png'
            native.parent.mkdir(parents=True)
            Image.new('RGB', (400, 300), '#7650c0').save(native)
            mask = io.BytesIO()
            Image.new('RGBA', (1, 1), (255, 255, 255, 0)).save(mask, format='PNG')
            job = yero_relay.validate_job({'prompt': 'Edit the glass', 'reference': DATA_URL,
                'mask': 'data:image/png;base64,' + base64.b64encode(mask.getvalue()).decode('ascii')})
            result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port,
                                            'existing-bridge-key', bridge_state_dir=Path(folder))
            self.assertEqual(result['status'], 'failed')
            self.assertIn('比例', result['error'])
            Image.new('RGB', (300, 300), '#7650c0').save(native)
            result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port,
                                            'existing-bridge-key', bridge_state_dir=Path(folder))
            self.assertEqual(result['status'], 'completed', result)

    def test_guided_edit_recovers_only_the_matching_generated_file_when_bridge_loses_its_path(self):
        import yero_relay
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            bridge = root / 'bridge'
            codex = root / 'codex'
            thread = '01a19bc6-d1cd-7c22-8af5-c804045d4c17'
            image_dir = codex / 'generated_images' / thread
            image_dir.mkdir(parents=True)
            mask = io.BytesIO()
            Image.new('RGBA', (1, 1), (255, 255, 255, 0)).save(mask, format='PNG')
            job = yero_relay.validate_job({'prompt': 'Edit the cup', 'reference': DATA_URL,
                'mask': 'data:image/png;base64,' + base64.b64encode(mask.getvalue()).decode('ascii')})
            scenario = {'matching': True, 'ambiguous': False, 'size': (100, 100)}

            def failed_bridge(request, timeout):
                envelope = ('Content-Type: ' + request.get_header('Content-type') + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + request.data
                parts = list(BytesParser(policy=policy.default).parsebytes(envelope).iter_parts())
                fields = {part.get_param('name', header='Content-Disposition'): part.get_payload(decode=True).decode('utf-8')
                          for part in parts if not part.get_filename()}
                trace = fields['yero_request_id']
                record = bridge / 'jobs' / ('f' * 32)
                record.mkdir(parents=True, exist_ok=True)
                (record / 'request.json').write_text(json.dumps({'fields': {'yero_request_id': trace if scenario['matching'] else '0' * 32}}))
                (record / 'events.jsonl').write_text(json.dumps({'type': 'thread.started', 'thread_id': thread}) + '\n')
                (record / 'worker-result.json').write_text(json.dumps({'status': 'failed', 'error': 'ImageGen returned no accessible generated file path or image data.'}))
                Image.new('RGB', scenario['size'], '#7650c0').save(image_dir / 'exec-test.png')
                if scenario['ambiguous']:
                    Image.new('RGB', (100, 100), '#ffffff').save(image_dir / 'exec-other.png')
                error = json.dumps({'error': {'message': 'ImageGen returned no accessible generated file path or image data.'}}).encode()
                raise urllib.error.HTTPError(request.full_url, 502, 'failed', {}, io.BytesIO(error))

            with mock.patch.dict(os.environ, {'CODEX_HOME': str(codex)}), mock.patch.object(yero_relay.OPENER, 'open', side_effect=failed_bridge):
                result = yero_relay.perform_job(job, 'http://127.0.0.1', 'test', bridge_state_dir=bridge)
                self.assertEqual(result['status'], 'completed', result)
                with Image.open(io.BytesIO(base64.b64decode(result['image'].split(',', 1)[1]))) as image:
                    self.assertEqual(image.size, (1, 1))
                    self.assertEqual(image.convert('RGB').getpixel((0, 0)), (118, 80, 192))
                scenario['matching'] = False
                self.assertEqual(yero_relay.perform_job(job, 'http://127.0.0.1', 'test', bridge_state_dir=bridge)['status'], 'failed')
                scenario.update(matching=True, size=(100, 80))
                self.assertIn('比例', yero_relay.perform_job(job, 'http://127.0.0.1', 'test', bridge_state_dir=bridge)['error'])
                scenario.update(ambiguous=True, size=(100, 100))
                self.assertEqual(yero_relay.perform_job(job, 'http://127.0.0.1', 'test', bridge_state_dir=bridge)['status'], 'failed')

    def test_missing_upscayl_fails_before_calling_image_generation(self):
        import yero_relay
        FakeBridge.paths.clear()
        job = yero_relay.validate_job({'prompt': 'A blue bird', 'resolution': '4K'})
        with tempfile.TemporaryDirectory() as folder, mock.patch.dict(os.environ, {'YERO_UPSCAYL_DIR': folder}):
            result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('Upscayl', result['error'])
        self.assertEqual(FakeBridge.paths, [])

    def test_upscayl_adapter_passes_image_and_returns_target_dimensions(self):
        import yero_relay
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cli = root / 'upscayl-bin-20251207-174704-windows' / 'upscayl-bin.exe'
            cli.parent.mkdir()
            cli.touch()
            (root / 'models').mkdir()
            for suffix in ('bin', 'param'):
                (root / 'models' / ('upscayl-lite-4x.' + suffix)).touch()
            for resolution, source_size, expected in [
                ('2K', (400, 200), (2048, 1024)),
                ('2K', (600, 997), (1232, 2048)),
                ('4K', (200, 400), (2048, 4096)),
            ]:
                with self.subTest(resolution=resolution):
                    def fake_upscayl(arguments, **kwargs):
                        self.assertEqual(Path(arguments[0]), cli)
                        self.assertEqual(arguments[arguments.index('-r') + 1], '%dx%d' % expected)
                        self.assertEqual(arguments[arguments.index('-t') + 1], '128')
                        self.assertEqual(arguments[arguments.index('-j') + 1], '1:1:1')
                        self.assertFalse(kwargs.get('shell', False))
                        with Image.open(arguments[arguments.index('-i') + 1]) as source:
                            self.assertEqual(source.size, source_size)
                        output = Path(arguments[arguments.index('-o') + 1])
                        Image.new('RGB', expected, '#7650c0').save(output)
                        return mock.Mock(returncode=0)
                    job = yero_relay.validate_job({'prompt': 'A blue bird', 'resolution': resolution})
                    with mock.patch.dict(os.environ, {'YERO_UPSCAYL_DIR': str(root)}), mock.patch('yero_relay.subprocess.run', fake_upscayl):
                        buffer = io.BytesIO()
                        Image.new('RGB', source_size, '#7650c0').save(buffer, format='PNG')
                        with mock.patch.object(FakeBridge, 'image', buffer.getvalue()):
                            result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key')
                    self.assertEqual(result['status'], 'completed', result)
                    with Image.open(io.BytesIO(base64.b64decode(result['image'].split(',', 1)[1]))) as image:
                        self.assertEqual(image.size, expected)

    def test_upscayl_rejects_incorrect_output_dimensions(self):
        import yero_relay
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cli = root / 'upscayl-bin-20251207-174704-windows' / 'upscayl-bin.exe'
            cli.parent.mkdir()
            cli.touch()
            (root / 'models').mkdir()
            for suffix in ('bin', 'param'):
                (root / 'models' / ('upscayl-lite-4x.' + suffix)).touch()
            def wrong_size(arguments, **kwargs):
                Image.new('RGB', (10, 10), 'blue').save(arguments[arguments.index('-o') + 1])
                return mock.Mock(returncode=0)
            job = yero_relay.validate_job({'prompt': 'A blue bird', 'resolution': '2K'})
            with mock.patch.dict(os.environ, {'YERO_UPSCAYL_DIR': str(root)}), mock.patch('yero_relay.subprocess.run', wrong_size):
                result = yero_relay.perform_job(job, 'http://127.0.0.1:%d' % self.bridge.server_port, 'existing-bridge-key')
            self.assertEqual(result['status'], 'failed')
            self.assertIn('尺寸', result['error'])


if __name__ == '__main__':
    unittest.main()

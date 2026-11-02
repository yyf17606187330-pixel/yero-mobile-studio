"""Image-only, authenticated relay for the existing loopback ImageGen bridge."""

import argparse
import base64
import binascii
import hmac
import io
import json
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

MAX_IMAGE_BYTES = 17 * 1024 * 1024
MAX_BODY_BYTES = 24 * 1024 * 1024
SIZES = {'1:1': '1024x1024', '3:4': '768x1024', '4:3': '1024x768',
         '16:9': '1280x720', '9:16': '720x1280'}
STYLES = {'自动', '品牌海报', '立体场景', '平面设计', '手绘插画', '自然摄影'}
RESOLUTIONS = {'原图': None, '1K': 1024, '2K': 2048, '4K': 4096}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class InputError(Exception):
    pass


def validate_job(payload):
    if not isinstance(payload, dict):
        raise InputError('请求格式不正确。')
    prompt = payload.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        raise InputError('请填写不超过 4000 字的画面描述。')
    ratio = payload.get('ratio', '1:1')
    style = payload.get('style', '自动')
    resolution = payload.get('resolution', '原图')
    if ratio not in SIZES or style not in STYLES or resolution not in RESOLUTIONS:
        raise InputError('画面设置不正确。')
    reference = payload.get('reference')
    image = None
    mime = None
    if reference is not None:
        if not isinstance(reference, str) or len(reference) > (MAX_IMAGE_BYTES * 4 // 3 + 100):
            raise InputError('参考图请不大于 17 MB。')
        match = re.fullmatch(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)', reference)
        if not match:
            raise InputError('参考图格式不正确。')
        try:
            image = base64.b64decode(match.group(2), validate=True)
        except (ValueError, binascii.Error) as exc:
            raise InputError('参考图格式不正确。') from exc
        if not image or len(image) > MAX_IMAGE_BYTES:
            raise InputError('参考图请不大于 17 MB。')
        mime = match.group(1)
        signatures = {'image/png': image.startswith(b'\x89PNG\r\n\x1a\n'),
                      'image/jpeg': image.startswith(b'\xff\xd8\xff'),
                      'image/webp': image.startswith(b'RIFF') and image[8:12] == b'WEBP'}
        if not signatures[mime]:
            raise InputError('参考图格式不正确。')
    mask = payload.get('mask')
    mask_data = None
    if mask is not None:
        if image is None or not isinstance(mask, str) or len(mask) > 4 * 1024 * 1024:
            raise InputError('局部修改选区无效。')
        match = re.fullmatch(r'data:image/png;base64,([A-Za-z0-9+/=]+)', mask)
        try:
            mask_data = base64.b64decode(match.group(1), validate=True) if match else None
            if not mask_data or not mask_data.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Invalid mask')
            with Image.open(io.BytesIO(image)) as target, Image.open(io.BytesIO(mask_data)) as selection:
                if target.size != selection.size or 'A' not in selection.getbands():
                    raise ValueError('Invalid mask size or alpha')
                if selection.getchannel('A').getextrema()[0] == 255:
                    raise ValueError('Empty selection')
        except (ValueError, OSError, binascii.Error) as exc:
            raise InputError('局部修改选区无效。') from exc
    return {'prompt': prompt.strip(), 'ratio': ratio, 'style': style, 'resolution': resolution, 'image': image, 'mime': mime, 'mask': mask_data}


def build_request(job, bridge_url, bridge_key, trace=None):
    guide = None
    if job.get('mask'):
        with Image.open(io.BytesIO(job['image'])) as source, Image.open(io.BytesIO(job['mask'])) as selection:
            width, height = source.size
            size = tuple(max(1, round(side * 1024 / max(width, height))) for side in (width, height))
            marked = source.convert('RGB')
            opacity = selection.getchannel('A').point(lambda alpha: (255 - alpha) * 3 // 5)
            marked.paste((255, 0, 160), mask=opacity)
            buffer = io.BytesIO()
            marked.save(buffer, format='PNG', compress_level=4)
            guide = buffer.getvalue()
        prompt = (job['prompt'] + '\n第一张是未标记的原图，第二张是同一画面上的紫红色定位示意。'
                  '笔迹只表示大致位置，不是严格的编辑边界；请结合用户指令识别并自然处理完整目标，'
                  '必要时延伸到笔迹之外，保持其余无关内容、结构、文字和标识尽量不变。'
                  '保留原图的视角、完整构图和长宽比，只输出编辑后的完整画面，'
                  '不要保留标记或产生黑边、拼贴和拉伸。风格方向：' + job['style'] + '。')
        requested_size = '%dx%d' % size
    else:
        prompt = job['prompt'] + '\n画面比例：' + job['ratio'] + '。风格方向：' + job['style'] + '。'
        requested_size = SIZES[job['ratio']]
    fields = {'model': 'codex-imagegen', 'prompt': prompt, 'size': requested_size,
              'n': '1', 'output_format': 'png'}
    if trace:
        fields['yero_request_id'] = trace
    headers = {'Authorization': 'Bearer ' + bridge_key}
    if job['image'] is None:
        data = json.dumps(fields, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
        endpoint = '/v1/images/generations'
    else:
        boundary = 'yero-' + secrets.token_hex(16)
        parts = []
        for name, value in fields.items():
            parts.append(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name +
                          '"\r\n\r\n' + value + '\r\n').encode('utf-8'))
        parts.append(('--' + boundary + '\r\nContent-Disposition: form-data; name="image"; '
                      'filename="reference"\r\nContent-Type: ' + job['mime'] + '\r\n\r\n').encode('ascii'))
        parts.extend((job['image'], b'\r\n'))
        if guide is not None:
            parts.append(('--' + boundary + '\r\nContent-Disposition: form-data; name="image[]"; filename="location-guide.png"\r\nContent-Type: image/png\r\n\r\n').encode('ascii'))
            parts.extend((guide, b'\r\n'))
        parts.append(('--' + boundary + '--\r\n').encode('ascii'))
        data = b''.join(parts)
        headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
        endpoint = '/v1/images/edits'
    return urllib.request.Request(bridge_url.rstrip('/') + endpoint, data=data, headers=headers, method='POST')


def upscayl_upscale(raw, target, cli, models):
    with Image.open(io.BytesIO(raw)) as source:
        width, height = source.size
    with tempfile.TemporaryDirectory(prefix='yero-upscayl-') as folder:
        root = Path(folder)
        source_path, output = root / 'input.png', root / 'output.png'
        source_path.write_bytes(raw)
        target_size = tuple(max(1, round(side * target / max(width, height))) for side in (width, height))
        command = [str(cli), '-i', str(source_path), '-o', str(output), '-m', str(models),
                   '-n', 'upscayl-lite-4x', '-z', '4', '-r', '%dx%d' % target_size,
                   '-t', '128', '-j', '1:1:1', '-f', 'png']
        try:
            completed = subprocess.run(command, cwd=str(cli.parent), timeout=300, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=False)
            if completed.returncode != 0 or not output.is_file():
                raise InputError('Upscayl 超分失败，请检查本机显存和程序。')
            data = output.read_bytes()
            with Image.open(io.BytesIO(data)) as result:
                result.load()
                if max(result.size) != target or abs(result.width * height - result.height * width) > max(width, height):
                    raise InputError('Upscayl 输出尺寸不正确，请检查超分设置。')
            return data
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise InputError('Upscayl 超分失败，请检查本机显存和程序。') from exc


def recover_generated_image(state_dir, trace, started):
    """Recover only a fresh file tied to this exact bridge request and worker thread."""
    roots = [Path.home() / '.codex' / 'generated_images']
    if os.environ.get('CODEX_HOME'):
        roots.append(Path(os.environ['CODEX_HOME']) / 'generated_images')
    matches = set()
    for record in (Path(state_dir) / 'jobs').glob('*/request.json'):
        try:
            if record.stat().st_mtime < started - 5 or json.loads(record.read_text(encoding='utf-8'))['fields'].get('yero_request_id') != trace:
                continue
            result = json.loads((record.parent / 'worker-result.json').read_text(encoding='utf-8-sig'))
            if result.get('status') != 'failed' or result.get('error') != 'ImageGen returned no accessible generated file path or image data.':
                continue
            events = [json.loads(line) for line in (record.parent / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
            threads = {event.get('thread_id') for event in events if event.get('type') == 'thread.started'}
            if len(threads) != 1:
                continue
            thread = next(iter(threads))
            if not isinstance(thread, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', thread):
                continue
            for root in roots:
                directory = (root / thread).resolve()
                if not directory.is_relative_to(root.resolve()):
                    continue
                for image in directory.glob('exec-*.png'):
                    image = image.resolve()
                    if image.is_relative_to(directory) and image.is_file() and image.stat().st_mtime >= started - 5:
                        matches.add(image)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    if len(matches) != 1:
        return None
    data = matches.pop().read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        image.verify()
    return data


def perform_job(job, bridge_url, bridge_key, bridge_state_dir=None):
    try:
        upscayl = Path(os.environ.get('YERO_UPSCAYL_DIR', r'D:\CodexData\YeroImageTest-20261029\upscayl'))
        cli = upscayl / 'upscayl-bin-20251207-174704-windows' / 'upscayl-bin.exe'
        models = upscayl / 'models'
        if job['resolution'] in ('2K', '4K') and not all(path.is_file() for path in
                (cli, models / 'upscayl-lite-4x.bin', models / 'upscayl-lite-4x.param')):
            raise InputError('Upscayl 超分暂不可用：未找到程序或轻量模型。')
        trace = secrets.token_hex(16) if job.get('mask') and bridge_state_dir is not None else None
        request = build_request(job, bridge_url, bridge_key, trace=trace)
        started = time.time()
        recovered = None
        try:
            with OPENER.open(request, timeout=930) as response:
                payload = json.loads(response.read(100 * 1024 * 1024))
        except urllib.error.HTTPError as exc:
            try:
                message = json.loads(exc.read().decode('utf-8')).get('error', {}).get('message')
            except (ValueError, UnicodeError):
                message = None
            if exc.code == 502 and trace and message == 'ImageGen returned no accessible generated file path or image data.':
                recovered = recover_generated_image(bridge_state_dir, trace, started)
            if recovered is None:
                raise
        if recovered is not None:
            with Image.open(io.BytesIO(job['image'])) as source, Image.open(io.BytesIO(recovered)) as generated:
                if abs((generated.width / generated.height) / (source.width / source.height) - 1) > 0.03:
                    raise InputError('模型返回的画面比例与原图不一致，请重试。')
                buffer = io.BytesIO()
                generated.resize(source.size, Image.Resampling.LANCZOS).save(buffer, format='PNG', compress_level=4)
                raw = buffer.getvalue()
        else:
            image = payload['data'][0]['b64_json']
            if not isinstance(image, str):
                raise ValueError('Invalid generated image')
            raw = base64.b64decode(image, validate=True)
            if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Invalid generated image')
        if recovered is None and job['image'] is not None and bridge_state_dir is not None:
            job_id = payload.get('bridge', {}).get('job_id', '')
            if not re.fullmatch(r'[0-9a-f]{32}', job_id):
                raise ValueError('Native image identifier is unavailable')
            root = Path(bridge_state_dir).resolve() / 'jobs'
            native = (root / job_id / 'native-output.png').resolve()
            if not native.is_relative_to(root.resolve()):
                raise ValueError('Invalid native image path')
            if job.get('mask'):
                with Image.open(io.BytesIO(job['image'])) as source, Image.open(native) as generated:
                    source_ratio = source.width / source.height
                    generated_ratio = generated.width / generated.height
                    if abs(generated_ratio / source_ratio - 1) > 0.03:
                        raise InputError('模型返回的画面比例与原图不一致，请重试。')
            else:
                raw = native.read_bytes()
        target = RESOLUTIONS[job['resolution']]
        mime = 'image/png'
        if job['resolution'] in ('2K', '4K'):
            raw = upscayl_upscale(raw, target, cli, models)
        elif target is not None:
            with Image.open(io.BytesIO(raw)) as source:
                source.load()
                scale = target / max(source.size)
                size = (max(1, round(source.width * scale)), max(1, round(source.height * scale)))
                output = source.resize(size, Image.Resampling.LANCZOS) if source.size != size else source.copy()
                buffer = io.BytesIO()
                output.save(buffer, format='PNG', compress_level=4)
                raw = buffer.getvalue()
        if len(raw) > 17 * 1024 * 1024:
            with Image.open(io.BytesIO(raw)) as output:
                buffer = io.BytesIO()
                output.save(buffer, format='WEBP', quality=92, method=4)
                raw = buffer.getvalue()
                mime = 'image/webp'
        if len(raw) > 17 * 1024 * 1024:
            return {'status': 'failed', 'error': '图片数据过大，请尝试较低分辨率。'}
        return {'status': 'completed', 'image': 'data:' + mime + ';base64,' + base64.b64encode(raw).decode('ascii')}
    except urllib.error.HTTPError as exc:
        message = '生图服务正忙，请稍后再试。' if exc.code == 429 else '生图服务暂时不可用，请稍后再试。'
        return {'status': 'failed', 'error': message}
    except InputError as exc:
        return {'status': 'failed', 'error': str(exc)}
    except Exception:
        return {'status': 'failed', 'error': '生图服务暂时不可用，请稍后再试。'}


class ImageRelay(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, relay_key, bridge_url, bridge_key):
        super().__init__(address, Handler)
        self.relay_key, self.bridge_url, self.bridge_key = relay_key, bridge_url, bridge_key
        self.jobs = {}
        self.guard = threading.Lock()

    def submit(self, job):
        with self.guard:
            now = time.time()
            self.jobs = {key: value for key, value in self.jobs.items()
                         if value['status'] == 'running' or now - value['created'] < 3600}
            if any(item['status'] == 'running' for item in self.jobs.values()):
                return None
            while len(self.jobs) >= 10:
                self.jobs.pop(next(iter(self.jobs)))
            job_id = secrets.token_hex(16)
            self.jobs[job_id] = {'status': 'running', 'created': now}
        threading.Thread(target=self.run_job, args=(job_id, job), daemon=True).start()
        return job_id

    def run_job(self, job_id, job):
        result = perform_job(job, self.bridge_url, self.bridge_key)
        with self.guard:
            if job_id in self.jobs:
                self.jobs[job_id].update(result)


class Handler(BaseHTTPRequestHandler):
    server_version = 'YeroImageRelay'
    sys_version = ''

    def log_message(self, *args):
        pass

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        provided = self.headers.get('X-Yero-Relay', '')
        return hmac.compare_digest(provided.encode('utf-8'), self.server.relay_key.encode('utf-8'))

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {'error': '未授权。'})
        match = re.fullmatch(r'/jobs/([0-9a-f]{32})', self.path)
        if not match:
            return self.send_json(404, {'error': '接口不存在。'})
        with self.server.guard:
            state = self.server.jobs.get(match.group(1))
            result = dict(state) if state else None
        if result is None:
            return self.send_json(404, {'error': '任务不存在或已过期。'})
        result.pop('created', None)
        return self.send_json(200, result)

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {'error': '未授权。'})
        if self.path != '/jobs':
            return self.send_json(404, {'error': '接口不存在。'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY_BYTES:
                return self.send_json(413, {'error': '上传内容过大。'})
            job = validate_job(json.loads(self.rfile.read(length)))
        except (ValueError, InputError, UnicodeError) as exc:
            message = str(exc) if isinstance(exc, InputError) else '请求格式不正确。'
            return self.send_json(400, {'error': message})
        job_id = self.server.submit(job)
        if job_id is None:
            return self.send_json(429, {'error': '已有图片正在生成，请稍后再试。'})
        return self.send_json(202, {'id': job_id, 'status': 'running'})


def make_server(host, port, relay_key, bridge_url, bridge_key):
    return ImageRelay((host, port), relay_key, bridge_url, bridge_key)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--relay-key-file', required=True, type=Path)
    parser.add_argument('--bridge-config', default=Path(r'D:\CodexData\ImageGenRemote\settings.json'), type=Path)
    parser.add_argument('--port', type=int, default=18769)
    args = parser.parse_args()
    relay_key = args.relay_key_file.read_text(encoding='utf-8').strip()
    config = json.loads(args.bridge_config.read_text(encoding='utf-8-sig'))
    if len(relay_key) < 32:
        raise ValueError('Relay key is missing or too short')
    if config.get('host') != '127.0.0.1':
        raise ValueError('Expected a loopback-only bridge')
    bridge_url = 'http://127.0.0.1:' + str(int(config['port']))
    server = make_server('127.0.0.1', args.port, relay_key, bridge_url, config['api_key'])
    server.serve_forever()


if __name__ == '__main__':
    main()

"""Outbound-only worker for the Yero image test; the original bridge stays private."""

import argparse
import json
import os
import re
import secrets
import time
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from websockets.sync.client import connect
from yero_relay import MAX_BODY_BYTES, InputError, perform_job, validate_job

USER_AGENT = 'Mozilla/5.0 (compatible; YeroImageTest/1.0)'


class Runner:
    kind = 'image'
    def __init__(self, cloud_url, runner_key, storage_key, bridge_url, bridge_key, state_dir, bridge_state_dir=None):
        self.cloud_url = cloud_url.rstrip('/')
        self.runner_key, self.storage_key = runner_key, storage_key
        self.bridge_url, self.bridge_key = bridge_url, bridge_key
        self.bridge_state_dir = bridge_state_dir
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.seen_path = self.state_dir / 'seen.json'
        self.cloud = urllib.request.build_opener()
        try:
            self.seen = json.loads(self.seen_path.read_text(encoding='utf-8'))
            if not isinstance(self.seen, dict):
                self.seen = {}
        except (OSError, ValueError):
            self.seen = {}
        self.seen = {key: value for key, value in self.seen.items()
                     if re.fullmatch(r'[0-9a-f]{32}', key) and isinstance(value, (int, float)) and time.time() - value < 7200}

    def seal(self, value):
        nonce = secrets.token_bytes(12)
        return nonce + AESGCM(self.storage_key).encrypt(nonce, value, None)

    def open(self, value):
        if len(value) < 29:
            raise ValueError('Invalid encrypted payload')
        return AESGCM(self.storage_key).decrypt(value[:12], value[12:], None)

    def remember(self, job_id):
        self.seen[job_id] = time.time()
        temporary = self.seen_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.seen), encoding='utf-8')
        os.replace(temporary, self.seen_path)

    def result_endpoint(self, job_id):
        return '/api/runner/result/' + job_id

    def process_payload(self, payload):
        job = validate_job(payload)
        return perform_job(job, self.bridge_url, self.bridge_key, bridge_state_dir=self.bridge_state_dir)

    def flush_outbox(self):
        for path in self.state_dir.glob('*.pending'):
            job_id = path.stem
            if not re.fullmatch(r'[0-9a-f]{32}', job_id):
                continue
            body = path.read_bytes()
            request = urllib.request.Request(self.cloud_url + self.result_endpoint(job_id), data=body,
                                             headers={'X-Yero-Runner': self.runner_key, 'Content-Type': 'application/octet-stream',
                                                      'User-Agent': USER_AGENT}, method='POST')
            with self.cloud.open(request, timeout=90) as response:
                if response.status != 200:
                    raise RuntimeError('Result upload failed')
            self.remember(job_id)
            os.replace(path, path.with_suffix('.sent'))
            (self.state_dir / (job_id + '.processing')).unlink(missing_ok=True)
            return True
        return False

    def run_job(self, job_id):
        if not re.fullmatch(r'[0-9a-f]{32}', job_id):
            raise ValueError('Invalid job identifier')
        while self.flush_outbox():
            pass
        if job_id in self.seen:
            return False
        request = urllib.request.Request(self.cloud_url + '/api/runner/job/' + job_id + '?kind=' + self.kind,
                                         headers={'X-Yero-Runner': self.runner_key, 'User-Agent': USER_AGENT})
        # KV can briefly lag behind the notification. Retry this job only.
        for attempt in range(7):
            try:
                with self.cloud.open(request, timeout=30) as response:
                    encrypted = response.read(MAX_BODY_BYTES + 28)
                break
            except urllib.error.HTTPError as exc:
                if exc.code != 404:
                    raise
                if attempt == 6:
                    return self.store_result(job_id, {'status': 'failed', 'error': '任务暂不可用，请重新提交。'})
                time.sleep(2 ** attempt)
        marker = self.state_dir / (job_id + '.processing')
        if marker.exists():
            result = {'status': 'failed', 'error': '任务因本机中断而停止，请重新提交。'}
        else:
            # A surviving marker means generation may already have been charged.
            marker.touch(exist_ok=False)
            try:
                result = self.process_payload(json.loads(self.open(encrypted)))
            except InputError as exc:
                result = {'status': 'failed', 'error': str(exc)}
            except Exception:
                result = {'status': 'failed', 'error': '任务内容无效，请重新提交。'}
        return self.store_result(job_id, result)

    def store_result(self, job_id, result):
        sealed = self.seal(json.dumps(result, ensure_ascii=False).encode('utf-8'))
        temporary = self.state_dir / (job_id + '.tmp')
        pending = self.state_dir / (job_id + '.pending')
        temporary.write_bytes(sealed)
        os.replace(temporary, pending)
        self.flush_outbox()
        return True

    def watch(self, on_idle=None):
        parts = urllib.parse.urlsplit(self.cloud_url)
        url = ('wss' if parts.scheme == 'https' else 'ws') + '://' + parts.netloc + parts.path.rstrip('/')
        url += '/api/runner/events?kind=' + self.kind
        while True:
            try:
                while self.flush_outbox():
                    pass
                with connect(url, additional_headers={'X-Yero-Runner': self.runner_key},
                             open_timeout=20, ping_interval=20, ping_timeout=20, max_size=4096) as socket:
                    while True:
                        try:
                            event = json.loads(socket.recv(timeout=20))
                        except TimeoutError:
                            if on_idle:
                                on_idle()
                            continue
                        if isinstance(event, dict) and event.get('kind') == self.kind:
                            self.run_job(event.get('id', ''))
            except Exception:
                print('Cloud connection unavailable; retrying.', flush=True)
                time.sleep(10)


def lock_runner(state_dir):
    """Keep only one local process for each image or voice state directory."""
    path = Path(state_dir) / 'runner.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open('a+b')
    handle.seek(0, os.SEEK_END)
    if not handle.tell():
        handle.write(b'0')
        handle.flush()
    handle.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError('A Yero runner is already using this state directory')
    return handle


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--secret-dir', required=True, type=Path)
    parser.add_argument('--bridge-config', default=Path(r'D:\CodexData\ImageGenRemote\settings.json'), type=Path)
    parser.add_argument('--url', default='https://yero-mobile-studio.pages.dev')
    args = parser.parse_args()
    if urllib.parse.urlsplit(args.url).scheme != 'https':
        raise ValueError('Cloud connection must use HTTPS')
    config = json.loads(args.bridge_config.read_text(encoding='utf-8-sig'))
    if config.get('host') != '127.0.0.1':
        raise ValueError('Expected a loopback-only bridge')
    runner_key = (args.secret_dir / 'relay-key.txt').read_text(encoding='utf-8').strip()
    storage_key = bytes.fromhex((args.secret_dir / 'storage-key.txt').read_text(encoding='utf-8').strip())
    if len(runner_key) < 32 or len(storage_key) != 32:
        raise ValueError('Test credentials are missing or invalid')
    runner = Runner(args.url, runner_key, storage_key, 'http://127.0.0.1:' + str(int(config['port'])),
                    config['api_key'], args.secret_dir / 'runner-state', bridge_state_dir=Path(config['state_dir']))
    lock = lock_runner(runner.state_dir)
    print('Yero outbound image runner started.', flush=True)
    runner.watch()


if __name__ == '__main__':
    main()

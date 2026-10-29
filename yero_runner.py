"""Outbound-only worker for the Yero image test; the original bridge stays private."""

import argparse
import json
import os
import re
import secrets
import time
import urllib.parse
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from yero_relay import InputError, perform_job, validate_job


class Runner:
    def __init__(self, cloud_url, runner_key, storage_key, bridge_url, bridge_key, state_dir, bridge_state_dir=None):
        self.cloud_url = cloud_url.rstrip('/')
        self.runner_key, self.storage_key = runner_key, storage_key
        self.bridge_url, self.bridge_key = bridge_url, bridge_key
        self.bridge_state_dir = bridge_state_dir
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.seen_path = self.state_dir / 'seen.json'
        self.last = ''
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

    def flush_outbox(self):
        for path in self.state_dir.glob('*.pending'):
            job_id = path.stem
            if not re.fullmatch(r'[0-9a-f]{32}', job_id):
                continue
            body = path.read_bytes()
            request = urllib.request.Request(self.cloud_url + '/api/runner/result/' + job_id, data=body,
                                             headers={'X-Yero-Runner': self.runner_key, 'Content-Type': 'application/octet-stream',
                                                      'User-Agent': 'Mozilla/5.0 (compatible; YeroImageTest/1.0)'}, method='POST')
            with self.cloud.open(request, timeout=90) as response:
                if response.status != 200:
                    raise RuntimeError('Result upload failed')
            self.remember(job_id)
            os.replace(path, path.with_suffix('.sent'))
            return True
        return False

    def run_once(self, force=False):
        if self.flush_outbox():
            return True
        query = urllib.parse.urlencode({'last': self.last, 'force': '1' if force else '0'})
        seen = ','.join(list(self.seen)[-100:])
        request = urllib.request.Request(self.cloud_url + '/api/runner/next?' + query,
                                         headers={'X-Yero-Runner': self.runner_key, 'X-Yero-Seen': seen,
                                                  'User-Agent': 'Mozilla/5.0 (compatible; YeroImageTest/1.0)'})
        with self.cloud.open(request, timeout=30) as response:
            latest = response.headers.get('X-Yero-Latest', '')
            if response.status == 204:
                self.last = latest
                return False
            job_id = response.headers.get('X-Yero-Job', '')
            encrypted = response.read(20 * 1024 * 1024)
        if not re.fullmatch(r'[0-9a-f]{32}', job_id) or job_id in self.seen:
            raise ValueError('Invalid job identifier')
        try:
            job = validate_job(json.loads(self.open(encrypted)))
            result = perform_job(job, self.bridge_url, self.bridge_key, bridge_state_dir=self.bridge_state_dir)
        except InputError as exc:
            result = {'status': 'failed', 'error': str(exc)}
        except Exception:
            result = {'status': 'failed', 'error': '任务内容无效，请重新提交。'}
        sealed = self.seal(json.dumps(result, ensure_ascii=False).encode('utf-8'))
        temporary = self.state_dir / (job_id + '.tmp')
        pending = self.state_dir / (job_id + '.pending')
        temporary.write_bytes(sealed)
        os.replace(temporary, pending)
        self.flush_outbox()
        return True


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
    next_scan = 0
    print('Yero outbound image runner started.', flush=True)
    while True:
        force = time.monotonic() >= next_scan
        if force:
            next_scan = time.monotonic() + 120
        try:
            worked = runner.run_once(force=force)
            time.sleep(2 if worked else 8)
        except Exception:
            print('Cloud connection unavailable; retrying.', flush=True)
            time.sleep(10)


if __name__ == '__main__':
    main()

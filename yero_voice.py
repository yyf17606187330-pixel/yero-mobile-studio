"""Private, outbound-only speech transcription for the existing Yero queue."""

import argparse
import base64
import binascii
import gc
import io
import re
import time
import urllib.parse
from pathlib import Path

from yero_relay import InputError
from yero_runner import Runner, lock_runner

MAX_AUDIO_BYTES = 2 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = SAMPLE_RATE * 60


def validate_voice_payload(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('audio'), str):
        raise InputError('没有收到录音，请重试。')
    match = re.fullmatch(r'data:audio/(webm|mp4|ogg|mpeg|wav|x-wav);base64,([A-Za-z0-9+/]+={0,2})', payload['audio'])
    if not match or len(match[2]) > ((MAX_AUDIO_BYTES + 2) // 3) * 4:
        raise InputError('录音格式不正确或文件过大。')
    try:
        data = base64.b64decode(match[2], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise InputError('录音格式不正确，请重试。') from exc
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise InputError('录音文件过大，请缩短后重试。')
    mime = match[1]
    valid = ((mime == 'webm' and data.startswith(b'\x1a\x45\xdf\xa3')) or
             (mime == 'mp4' and data[4:8] == b'ftyp') or
             (mime == 'ogg' and data.startswith(b'OggS')) or
             (mime == 'mpeg' and (data.startswith(b'ID3') or (len(data) > 1 and data[0] == 0xff and data[1] & 0xe0 == 0xe0))) or
             (mime in ('wav', 'x-wav') and data[:4] == b'RIFF' and data[8:12] == b'WAVE'))
    if not valid:
        raise InputError('录音格式不正确，请重试。')
    return data


def decode_voice(data):
    import av
    import numpy as np

    chunks = []
    count = 0
    try:
        resampler = av.audio.resampler.AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
        with av.open(io.BytesIO(data), mode='r', metadata_errors='ignore') as container:
            for frame in container.decode(audio=0):
                for output in resampler.resample(frame):
                    samples = output.to_ndarray().reshape(-1)
                    count += samples.size
                    if count > MAX_SAMPLES:
                        raise InputError('录音超过一分钟，请缩短后重试。')
                    chunks.append(samples)
            for output in resampler.resample(None):
                samples = output.to_ndarray().reshape(-1)
                count += samples.size
                if count > MAX_SAMPLES:
                    raise InputError('录音超过一分钟，请缩短后重试。')
                chunks.append(samples)
    except InputError:
        raise
    except Exception as exc:
        raise InputError('无法读取录音，请重新录制。') from exc
    if count < SAMPLE_RATE // 5:
        raise InputError('录音太短，请重新录制。')
    return np.concatenate(chunks).astype(np.float32) / 32768.0


class SpeechTranscriber:
    def __init__(self, model_name='base'):
        self.model_name = model_name
        self.model = None
        self.last_used = 0.0

    def __call__(self, data):
        audio = decode_voice(data)
        try:
            if self.model is None:
                from faster_whisper import WhisperModel
                self.model = WhisperModel(self.model_name, device='cpu', compute_type='int8', cpu_threads=2,
                                          local_files_only=True)
            segments, _ = self.model.transcribe(audio, beam_size=2, language=None, vad_filter=True,
                                                initial_prompt='以下是普通话的简体中文转写。',
                                                condition_on_previous_text=False)
            text = ''.join(segment.text for segment in segments).strip()
            self.last_used = time.monotonic()
        except Exception as exc:
            raise InputError('本机语音转录暂时不可用，请稍后重试。') from exc
        if not text:
            raise InputError('没有听清内容，请再说一次。')
        return text[:4000]

    def unload_if_idle(self, seconds=120):
        if self.model is not None and time.monotonic() - self.last_used >= seconds:
            self.model = None
            gc.collect()


class VoiceRunner(Runner):
    kind = 'voice'
    def __init__(self, cloud_url, runner_key, storage_key, state_dir, transcriber=None):
        super().__init__(cloud_url, runner_key, storage_key, '', '', state_dir)
        self.transcriber = transcriber or SpeechTranscriber()

    def result_endpoint(self, job_id):
        return '/api/runner/voice-result/' + job_id

    def process_payload(self, payload):
        text = self.transcriber(validate_voice_payload(payload))
        if not isinstance(text, str) or not text.strip():
            raise InputError('没有听清内容，请再说一次。')
        return {'status': 'completed', 'text': text.strip()[:4000]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--secret-dir', required=True, type=Path)
    parser.add_argument('--url', default='https://yero-mobile-studio.pages.dev')
    args = parser.parse_args()
    if urllib.parse.urlsplit(args.url).scheme != 'https':
        raise ValueError('Cloud connection must use HTTPS')
    runner_key = (args.secret_dir / 'relay-key.txt').read_text(encoding='utf-8').strip()
    storage_key = bytes.fromhex((args.secret_dir / 'storage-key.txt').read_text(encoding='utf-8').strip())
    if len(runner_key) < 32 or len(storage_key) != 32:
        raise ValueError('Test credentials are missing or invalid')
    transcriber = SpeechTranscriber()
    runner = VoiceRunner(args.url, runner_key, storage_key, args.secret_dir / 'voice-state', transcriber)
    lock = lock_runner(runner.state_dir)
    print('Yero voice transcription runner started.', flush=True)
    runner.watch(on_idle=transcriber.unload_if_idle)


if __name__ == '__main__':
    main()

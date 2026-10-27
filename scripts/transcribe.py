"""Offline Mac/CPU transcription. Install speech-requirements.txt in a private venv.
The model must be downloaded before starting Kit; request handling never downloads it.
"""
import argparse
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--model', default='tiny')
parser.add_argument('--language', default='auto', help='Speech language code, e.g. ru; auto detects it')
parser.add_argument('audio')
parser.add_argument('output')
args = parser.parse_args()
# Bound decoded audio as well as compressed upload size (WebM may lack duration).
import av
import numpy as np
frames = []
samples = 0
resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
with av.open(args.audio) as source:
    for frame in source.decode(audio=0):
        for converted in resampler.resample(frame):
            values = converted.to_ndarray().reshape(-1)
            samples += values.size
            if samples > 125 * 16000:
                raise ValueError('recording exceeds two minutes plus encoder tolerance')
            frames.append(values)
    for converted in resampler.resample(None):
        values = converted.to_ndarray().reshape(-1)
        samples += values.size
        if samples > 125 * 16000:
            raise ValueError('recording too long')
        frames.append(values)
if not frames:
    raise ValueError('empty recording')
audio = np.concatenate(frames).astype(np.float32) / 32768.0
from faster_whisper import WhisperModel
model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
segments, _ = model.transcribe(audio, language=None if args.language == 'auto' else args.language, beam_size=3, vad_filter=True, condition_on_previous_text=False)
text = ' '.join(segment.text.strip() for segment in segments).strip()
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf8') as stream:
    stream.write(text)

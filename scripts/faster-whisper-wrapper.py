#!/usr/bin/env python3
"""
faster-whisper CLI wrapper for WeChat bridge.
Supports: faster-whisper <audio_path> --language zh --output_format txt
Writes transcription to <audio_path>.txt and prints to stdout.

CRITICAL: Handles arbitrary WAV sample rates. Bridge produces:
  - Video audio: 16kHz mono (via ffmpeg extraction)
  - Voice fallback: 24kHz mono (via decodeSilkToWav)
This wrapper normalizes to 16kHz mono via ffmpeg before transcription.

FAILURE POLICY: If ffmpeg conversion fails (missing/non-zero/timeout),
  raise explicit exception, exit non-zero, do NOT fall back to original.
  Silent fallback would cause wrong-speed recognition (the original bug).

Setup:
  python3 -m venv /path/to/whisper-venv
  /path/to/whisper-venv/bin/pip install faster-whisper numpy
  # Download model once (needs network):
  HF_HUB_OFFLINE=0 /path/to/whisper-venv/bin/python -c \
    "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"
  # Then offline use works.

Install:
  sudo cp faster-whisper-wrapper.py /usr/local/bin/faster-whisper
  sudo chmod +x /usr/local/bin/faster-whisper
  # Edit shebang to point to your venv python, or set:
  # export WHISPER_VENV_PYTHON=/opt/whisper-venv/bin/python
"""
import sys
import os
import subprocess
import tempfile

VENV_PYTHON = os.environ.get('WHISPER_VENV_PYTHON', sys.executable)
if VENV_PYTHON != sys.executable and os.path.exists(VENV_PYTHON):
    os.execv(VENV_PYTHON, [VENV_PYTHON] + sys.argv)

os.environ.setdefault('HF_HUB_OFFLINE', '1')

import wave
import numpy as np
from faster_whisper import WhisperModel


class AudioConversionError(Exception):
    """Raised when ffmpeg audio normalization fails. Do not proceed."""
    pass


def normalize_to_16k_mono(input_path):
    """
    Read WAV header. If already 16kHz mono 16-bit, return as-is.
    Otherwise use ffmpeg to convert. On ANY failure, raise AudioConversionError.
    Never silently return the original non-16k file.
    """
    with wave.open(input_path, 'rb') as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()

    if sr == 16000 and ch == 1 and sw == 2:
        return input_path, False  # (path, is_temp)

    fd, tmp_path = tempfile.mkstemp(suffix='_16k.wav')
    os.close(fd)
    try:
        result = subprocess.run(
            ['ffmpeg', '-y', '-i', input_path,
             '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', tmp_path],
            capture_output=True, timeout=30
        )
    except FileNotFoundError:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise AudioConversionError("ffmpeg not found in PATH")
    except subprocess.TimeoutExpired:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise AudioConversionError("ffmpeg conversion timed out (30s)")

    if result.returncode != 0:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        err = result.stderr.decode(errors='replace')[-300:]
        raise AudioConversionError(f"ffmpeg exited non-zero ({result.returncode}): {err}")

    # Verify output header is actually 16k/mono/16bit
    try:
        with wave.open(tmp_path, 'rb') as wf:
            out_sr, out_ch, out_sw = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
    except Exception as e:
        os.unlink(tmp_path)
        raise AudioConversionError(f"converted file unreadable: {e}")

    if not (out_sr == 16000 and out_ch == 1 and out_sw == 2):
        os.unlink(tmp_path)
        raise AudioConversionError(
            f"conversion produced wrong format: {out_sr}Hz/{out_ch}ch/{out_sw*8}bit, expected 16000/1/16"
        )

    return tmp_path, True


def read_wav_as_float32(wav_path):
    """Read 16-bit PCM WAV as float32 numpy array (mono). Caller ensures 16k/mono."""
    with wave.open(wav_path, 'rb') as wf:
        n_frames = wf.getnframes()
        audio_data = wf.readframes(n_frames)
        sw = wf.getsampwidth()
        ch = wf.getnchannels()
        if sw == 2:
            audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
        elif sw == 1:
            audio_np = (np.frombuffer(audio_data, dtype=np.uint8).astype(np.float32) - 128) / 128.0
        else:
            raise ValueError(f"Unsupported sample width: {sw}")
        if ch == 2:
            audio_np = audio_np.reshape(-1, 2).mean(axis=1)
        elif ch > 2:
            audio_np = audio_np.reshape(-1, ch).mean(axis=1)
        return audio_np


def main():
    if len(sys.argv) < 2:
        print("Usage: faster-whisper <audio_file> [--language zh] [--output_format txt]", file=sys.stderr)
        sys.exit(2)

    input_file = sys.argv[1]
    lang = "zh"
    args = sys.argv[2:]
    for i, arg in enumerate(args):
        if arg == "--language" and i + 1 < len(args):
            lang = args[i + 1]

    txt_path = os.path.splitext(input_file)[0] + ".txt"

    # Normalize (may raise AudioConversionError -> non-zero exit, no txt written)
    try:
        normalized_path, is_temp = normalize_to_16k_mono(input_file)
    except AudioConversionError as e:
        print(f"ERROR: audio conversion failed: {e}", file=sys.stderr)
        sys.exit(3)

    try:
        audio_np = read_wav_as_float32(normalized_path)
        model = WhisperModel("tiny", device="cpu", compute_type="int8", local_files_only=True)
        segments, info = model.transcribe(audio_np, language=lang)
        text = " ".join([s.text for s in segments]).strip()
    finally:
        if is_temp and os.path.exists(normalized_path):
            os.unlink(normalized_path)

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(text)


if __name__ == "__main__":
    main()

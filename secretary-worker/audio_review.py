"""Long-recording support. Source audio is retained; derived chunks are disposable.
No speaker identity is inferred from voice or from a reused chunk-local label.
"""
from array import array
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import urllib.request
import uuid
import wave


def ffmpeg_binary():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def split_recording(source, output_directory, seconds=600):
    """Decode to small mono WAV segments, each well below the 25MB API ceiling."""
    if not 1 <= seconds <= 600:
        raise ValueError('chunk duration must be 1 to 600 seconds')
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    pattern = directory / 'part-%05d.wav'
    subprocess.run([ffmpeg_binary(), '-v', 'error', '-y', '-i', str(source),
                    '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
                    '-f', 'segment', '-segment_time', str(seconds), '-reset_timestamps', '1',
                    str(pattern)], check=True, capture_output=True, timeout=600)
    parts = []
    offset = 0.0
    for file in sorted(directory.glob('part-*.wav')):
        file.chmod(0o600)
        with wave.open(str(file), 'rb') as wav:
            duration = wav.getnframes() / wav.getframerate()
        if file.stat().st_size >= 25_000_000:
            raise ValueError('chunk exceeds transcription upload size')
        parts.append({'file': str(file), 'start': offset, 'duration': duration})
        offset += duration
    if not parts:
        raise ValueError('recording has no audio')
    return parts


def offset_segments(raw, offset, recording_id, chunk_index):
    """Label identity is scoped to a chunk; timestamps are recording-relative."""
    result = []
    for segment in raw.get('segments', []):
        start, end = float(segment['start']), float(segment['end'])
        if not math.isfinite(start) or not math.isfinite(end) or end < start:
            raise ValueError('invalid transcription timestamps')
        result.append({**segment, 'start': round(offset + start, 3),
                       'end': round(offset + end, 3),
                       'speaker': f'{recording_id}:chunk{chunk_index}:{segment.get("speaker", "unknown")}',
                       'speakerIdentity': 'anonymous chunk-local voice cluster; not matched across chunks'})
    return result


def transcribe_chunked(source, directory, recording_id, api_key, request=None):
    """Resumable per-chunk requests; raise on any failed chunk, never truncate."""
    if not api_key:
        raise ValueError('transcription credential unavailable')
    source_hash = hashlib.sha256(Path(source).read_bytes()).hexdigest()
    root = Path(directory) / source_hash
    parts = split_recording(source, root)
    all_segments = []
    for i, part in enumerate(parts):
        file = Path(part['file'])
        cache = file.with_suffix('.diarized.json')
        if cache.exists():
            raw = json.loads(cache.read_text())
        else:
            boundary = 'NWE' + uuid.uuid4().hex
            fields = {'model': 'gpt-4o-transcribe-diarize', 'response_format': 'diarized_json',
                      'chunking_strategy': 'auto'}
            body = b''
            for key, value in fields.items():
                body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
            body += file.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
            req = urllib.request.Request('https://api.openai.com/v1/audio/transcriptions', data=body,
                                         headers={'Authorization': 'Bearer ' + api_key,
                                                  'Content-Type': 'multipart/form-data; boundary=' + boundary})
            with (request or urllib.request.urlopen)(req, timeout=660) as response:
                raw = json.load(response)
            if not isinstance(raw.get('segments'), list):
                raise ValueError('diarized segments missing')
            temporary = cache.with_suffix('.tmp')
            temporary.write_text(json.dumps(raw, ensure_ascii=False)); temporary.chmod(0o600); temporary.replace(cache)
        all_segments.extend(offset_segments(raw, part['start'], recording_id, i + 1))
    return {'model': 'gpt-4o-transcribe-diarize', 'sourceSha256': source_hash,
            'durationSeconds': sum(p['duration'] for p in parts), 'chunks': len(parts),
            'speakerIdentity': 'anonymous labels scoped to each chunk; do not assume the same letter is the same person',
            'segments': all_segments}


def channel_activity(source, directory, threshold_db=-40, frame_ms=100, min_seconds=2):
    """Acoustic quiet/dual-track concurrency, explicitly not speaker-overlap proof."""
    output = Path(directory) / 'activity-stereo.wav'
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    subprocess.run([ffmpeg_binary(), '-v', 'error', '-y', '-i', str(source), '-map', '0:a:0',
                    '-ac', '2', '-ar', '8000', '-c:a', 'pcm_s16le', str(output)],
                   check=True, capture_output=True, timeout=600)
    output.chmod(0o600)
    intervals = {'quiet': [], 'bothTracksActive': []}
    opened = {key: None for key in intervals}
    threshold = 32768 * 10 ** (threshold_db / 20)
    cursor = 0
    try:
        with wave.open(str(output), 'rb') as wav:
            rate = wav.getframerate()
            while True:
                raw = wav.readframes(round(rate * frame_ms / 1000))
                if not raw:
                    break
                samples = array('h', raw)
                if sys.byteorder != 'little': samples.byteswap()
                n = len(samples) // 2
                active = [math.sqrt(sum(v*v for v in samples[ch::2]) / n) > threshold for ch in range(2)]
                flags = {'quiet': not any(active), 'bothTracksActive': all(active)}
                for key, flag in flags.items():
                    if flag and opened[key] is None: opened[key] = cursor
                    if not flag and opened[key] is not None:
                        start = opened[key]; opened[key] = None
                        if cursor - start + 1e-6 >= min_seconds:
                            intervals[key].append({'start': round(start, 3), 'end': round(cursor, 3)})
                cursor += n / rate
        for key, start in opened.items():
            if start is not None and cursor - start + 1e-6 >= min_seconds:
                intervals[key].append({'start': round(start, 3), 'end': round(cursor, 3)})
    finally:
        output.unlink(missing_ok=True)
    return {'durationSeconds': round(cursor, 3), 'thresholdDb': threshold_db, 'windowMs': frame_ms,
            'minimumSeconds': min_seconds, **intervals,
            'limitation': 'Channel activity is not verified human speech or turn interruption. Mono sources duplicated to stereo cannot establish overlap. Shared-channel speakers require diarization.'}

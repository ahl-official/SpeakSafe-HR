from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from app.config import Settings
from app.models import Case
from app.services.case_service import case_dir

ALLOWED_AUDIO_MIME_PREFIXES = ("audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg")
ALLOWED_SUFFIXES = {".webm", ".ogg", ".m4a", ".mp4"}


class AudioError(RuntimeError):
    pass


def extension_for_mime(mime_type: str) -> str:
    if "ogg" in mime_type:
        return ".ogg"
    if "mp4" in mime_type:
        return ".m4a"
    return ".webm"


def safe_chunk_path(settings: Settings, case_id: str, chunk_index: int, mime_type: str) -> Path:
    if chunk_index < 1 or chunk_index > 10000:
        raise AudioError("Invalid chunk index")
    if not any(mime_type.lower().startswith(prefix) for prefix in ALLOWED_AUDIO_MIME_PREFIXES):
        raise AudioError("Unsupported recording format")
    return (
        case_dir(settings, case_id) / "chunks" / f"{chunk_index:06d}{extension_for_mime(mime_type)}"
    )


def store_chunk(
    settings: Settings, case: Case, chunk_index: int, content_type: str, source
) -> bool:
    target = safe_chunk_path(
        settings, case.case_id, chunk_index, content_type or case.recording_mime_type
    )
    if target.exists():
        return False
    temporary = target.with_suffix(target.suffix + ".part")
    total = 0
    with temporary.open("wb") as destination:
        while data := source.read(1024 * 1024):
            total += len(data)
            if total > 20 * 1024 * 1024:
                destination.close()
                temporary.unlink(missing_ok=True)
                raise AudioError("Chunk is too large")
            destination.write(data)
    if total == 0:
        temporary.unlink(missing_ok=True)
        raise AudioError("Empty recording chunk")
    temporary.replace(target)
    return True


async def store_async_chunk(
    settings: Settings, case: Case, chunk_index: int, content_type: str, stream
) -> bool:
    """Persist an async request body incrementally, without buffering a recording chunk."""
    target = safe_chunk_path(
        settings, case.case_id, chunk_index, content_type or case.recording_mime_type
    )
    if target.exists():
        return False
    temporary = target.with_suffix(target.suffix + ".part")
    total = 0
    try:
        with temporary.open("xb") as destination:
            async for data in stream:
                total += len(data)
                if total > 20 * 1024 * 1024:
                    raise AudioError("Chunk is too large")
                destination.write(data)
        if total == 0:
            raise AudioError("Empty recording chunk")
        temporary.replace(target)
        return True
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def chunk_files(settings: Settings, case: Case) -> list[Path]:
    folder = case_dir(settings, case.case_id) / "chunks"
    return sorted(path for path in folder.iterdir() if path.suffix.lower() in ALLOWED_SUFFIXES)


def validate_expected_chunks(settings: Settings, case: Case, expected_count: int) -> list[Path]:
    files = chunk_files(settings, case)
    expected = [f"{number:06d}" for number in range(1, expected_count + 1)]
    actual = [file.stem for file in files]
    if actual != expected:
        raise AudioError("Some recording chunks are still being uploaded. Please try again.")
    return files


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=300, check=False)
    except FileNotFoundError as exc:
        raise AudioError("FFmpeg or FFprobe is not installed or not on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise AudioError("Audio processing timed out") from exc


def probe_duration(path: Path) -> float:
    result = _run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]
    )
    if result.returncode != 0:
        raise AudioError("The recording could not be validated")
    try:
        duration = float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError) as exc:
        raise AudioError("The recording duration is unavailable") from exc
    if duration <= 0:
        raise AudioError("The recording is invalid")
    return duration


def finalize_audio(settings: Settings, case: Case) -> tuple[Path, Path, float]:
    """Join MediaRecorder WebM chunks as one byte stream, then normalize with FFmpeg."""
    folder = case_dir(settings, case.case_id)
    source_path = folder / f"{case.case_id}-source.webm"
    processed_path = folder / f"{case.case_id}-audio.m4a"
    chunks = validate_expected_chunks(settings, case, case.expected_chunk_count)
    combined_size = sum(path.stat().st_size for path in chunks)
    source_rebuilt = False

    if source_path.exists() and source_path.stat().st_size < combined_size:
        source_path.replace(folder / f"{case.case_id}-source-incomplete.webm")
        source_rebuilt = True
    if source_rebuilt and processed_path.exists():
        processed_path.replace(folder / f"{case.case_id}-audio-incomplete.m4a")
    elif processed_path.exists() and case.recording_duration_seconds:
        existing_duration = probe_duration(processed_path)
        if existing_duration < case.recording_duration_seconds * 0.8:
            processed_path.replace(folder / f"{case.case_id}-audio-incomplete.m4a")

    if not source_path.exists():
        temporary = source_path.with_suffix(".webm.part")
        with temporary.open("wb") as destination:
            for chunk in chunks:
                with chunk.open("rb") as source:
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
        temporary.replace(source_path)
        source_rebuilt = True
        if processed_path.exists():
            processed_path.replace(folder / f"{case.case_id}-audio-incomplete.m4a")

    if not processed_path.exists():
        result = _run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(source_path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "aac",
                "-b:a",
                f"{settings.audio_bitrate_kbps}k",
                str(processed_path),
            ]
        )
        if result.returncode != 0:
            raise AudioError("Recording could not be normalized")

    duration = probe_duration(processed_path)
    if case.recording_duration_seconds and duration < case.recording_duration_seconds * 0.8:
        raise AudioError("The complete recording could not be recovered")
    return source_path, processed_path, duration


def transcription_ranges(
    total_duration: float, minutes: int, overlap_seconds: int
) -> list[tuple[float, float]]:
    segment_length = minutes * 60
    if total_duration <= 0 or segment_length <= 0:
        return []
    ranges: list[tuple[float, float]] = []
    start = 0.0
    while start < total_duration:
        end = min(total_duration, start + segment_length + overlap_seconds)
        ranges.append((start, end))
        start += segment_length
    return ranges


def create_segments(
    settings: Settings, case: Case, audio_path: Path, duration: float
) -> list[tuple[int, float, float, Path]]:
    segments_dir = case_dir(settings, case.case_id) / "segments"
    segments_dir.mkdir(exist_ok=True)
    output: list[tuple[int, float, float, Path]] = []
    for index, (start, end) in enumerate(
        transcription_ranges(
            duration, settings.transcription_segment_minutes, settings.transcription_overlap_seconds
        ),
        1,
    ):
        path = segments_dir / f"segment-{index:03d}.m4a"
        if not path.exists():
            result = _run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{start:.3f}",
                    "-t",
                    f"{end - start:.3f}",
                    "-i",
                    str(audio_path),
                    "-vn",
                    "-c:a",
                    "aac",
                    "-b:a",
                    f"{settings.audio_bitrate_kbps}k",
                    str(path),
                ]
            )
            if result.returncode != 0:
                raise AudioError("A transcription segment could not be created")
        output.append((index, start, end, path))
    return output

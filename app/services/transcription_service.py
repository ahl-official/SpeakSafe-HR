from __future__ import annotations

import re
import time
from pathlib import Path

import httpx

from app.config import Settings


class TranscriptionError(RuntimeError):
    pass


def deduplicate_overlap(previous: str, current: str, max_words: int = 80) -> str:
    """Remove only an exact normalized word overlap; do not rewrite a transcript."""
    previous_words = previous.split()
    current_words = current.split()
    best = 0
    for size in range(1, min(len(previous_words), len(current_words), max_words) + 1):
        if [word.lower().strip('.,!?;:"') for word in previous_words[-size:]] == [
            word.lower().strip('.,!?;:"') for word in current_words[:size]
        ]:
            best = size
    return " ".join(current_words[best:])


def merge_transcripts(transcripts: list[str]) -> str:
    merged = ""
    for transcript in transcripts:
        cleaned = re.sub(r"\s+", " ", transcript).strip()
        if not cleaned:
            continue
        merged = f"{merged} {deduplicate_overlap(merged, cleaned)}".strip() if merged else cleaned
    return merged


def transcript_request(audio_url: str, settings: Settings) -> dict[str, object]:
    """Build the high-accuracy multilingual AssemblyAI request for stored recordings."""
    return {
        "audio_url": audio_url,
        "speech_models": [settings.assemblyai_speech_model],
        "language_detection": settings.assemblyai_language_detection,
        "prompt": settings.assemblyai_transcription_prompt,
    }


class AssemblyAITranscriber:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def transcribe(self, path: Path) -> str:
        if self.settings.demo_mode:
            return "[Demo-generated transcript] The employee shared workplace feedback for HR review."
        if not self.settings.assemblyai_api_key:
            raise TranscriptionError("AssemblyAI is not configured")
        headers = {"authorization": self.settings.assemblyai_api_key}
        timeout = httpx.Timeout(60.0, connect=15.0)
        try:
            with path.open("rb") as audio, httpx.Client(timeout=timeout) as client:
                upload = client.post(
                    f"{self.settings.assemblyai_base_url}/upload", headers=headers, content=audio
                )
                upload.raise_for_status()
                audio_url = upload.json()["upload_url"]
                created = client.post(
                    f"{self.settings.assemblyai_base_url}/transcript",
                    headers=headers,
                    json=transcript_request(audio_url, self.settings),
                )
                created.raise_for_status()
                transcript_id = created.json()["id"]
                for _ in range(120):
                    result = client.get(
                        f"{self.settings.assemblyai_base_url}/transcript/{transcript_id}",
                        headers=headers,
                    )
                    result.raise_for_status()
                    payload = result.json()
                    if payload.get("status") == "completed":
                        return str(payload.get("text") or "")
                    if payload.get("status") == "error":
                        raise TranscriptionError("AssemblyAI could not transcribe a segment")
                    time.sleep(2)
        except httpx.HTTPStatusError as exc:
            raise TranscriptionError(f"AssemblyAI returned HTTP {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            raise TranscriptionError("AssemblyAI request failed") from exc
        raise TranscriptionError("AssemblyAI transcription timed out")
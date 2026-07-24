from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import httpx

from app.config import Settings


class AppsScriptClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.apps_script_webhook_url or not self.settings.apps_script_shared_secret:
            raise RuntimeError("Apps Script webhook is not configured")
        payload["secret"] = self.settings.apps_script_shared_secret
        try:
            response = httpx.post(
                self.settings.apps_script_webhook_url,
                json=payload,
                timeout=90.0,
                follow_redirects=True,
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError("Apps Script request failed") from exc
        if not body.get("ok"):
            safe_message = str(body.get("error") or "Apps Script request was rejected")[:200]
            raise RuntimeError(f"Apps Script rejected request: {safe_message}")
        return dict(body["result"])

    def upload_file(
        self, case_id: str, document_type: str, path: Path, replace_existing: bool = False
    ) -> tuple[str, str]:
        if path.stat().st_size > 35 * 1024 * 1024:
            raise RuntimeError(
                "Audio exceeds the Apps Script upload limit; lower duration or bitrate"
            )
        result = self.post(
            {
                "action": "upload",
                "case_id": case_id,
                "document_type": document_type,
                "filename": path.name,
                "mime_type": mime_for(path),
                "content_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
                "replace_existing": replace_existing,
            }
        )
        return str(result["id"]), str(result["link"])

    def upsert_sheet_row(self, row: dict[str, Any]) -> int:
        return int(self.post({"action": "sheet_upsert", "row": row})["row_number"])


def mime_for(path: Path) -> str:
    return {".m4a": "audio/mp4", ".txt": "text/plain", ".pdf": "application/pdf"}.get(
        path.suffix.lower(), "application/octet-stream"
    )

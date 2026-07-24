from __future__ import annotations

from pathlib import Path

from app.config import Settings
from app.services.apps_script_service import AppsScriptClient


class DriveService:
    """Idempotent Drive upload adapter; Apps Script uses a case/type property key."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = AppsScriptClient(settings)

    def upload(
        self, case_id: str, document_type: str, path: Path, replace_existing: bool = False
    ) -> tuple[str, str]:
        if self.settings.demo_mode:
            return f"demo-{case_id}-{document_type}", path.resolve().as_uri()
        return self.client.upload_file(case_id, document_type, path, replace_existing)

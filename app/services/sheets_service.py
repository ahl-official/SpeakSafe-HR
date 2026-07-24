from __future__ import annotations

import csv
from typing import Any

from app.config import Settings
from app.services.apps_script_service import AppsScriptClient

HEADERS = [
    "Case ID",
    "Submitted At",
    "Recording Duration",
    "Feedback Category",
    "Professional Summary",
    "Key Points",
    "People or Roles Mentioned",
    "Dates or Time References",
    "Workplace Impact",
    "Support Requested",
    "Urgency",
    "Safety Concern",
    "Information Not Clear",
    "Audio Recording",
    "Full Transcript",
    "PDF Report",
    "Processing Status",
    "HR Status",
    "Assigned HR",
    "HR Remarks",
    "Action Taken",
    "Closed At",
    "Last Updated",
]


class SheetsService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = AppsScriptClient(settings)

    def upsert(self, row: dict[str, Any]) -> int:
        if not self.settings.demo_mode:
            return self.client.upsert_sheet_row(row)
        path = self.settings.demo_csv_path
        path.parent.mkdir(parents=True, exist_ok=True)
        existing: list[dict[str, str]] = []
        if path.exists():
            with path.open("r", encoding="utf-8", newline="") as file:
                existing = list(csv.DictReader(file))
        row_number = next(
            (i + 2 for i, item in enumerate(existing) if item.get("Case ID") == str(row["Case ID"])),
            None,
        )
        cleaned = {header: str(row.get(header, "")) for header in HEADERS}
        if row_number:
            existing[row_number - 2] = cleaned
        else:
            existing.append(cleaned)
            row_number = len(existing) + 1
        with path.open("w", encoding="utf-8", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=HEADERS)
            writer.writeheader()
            writer.writerows(existing)
        return row_number
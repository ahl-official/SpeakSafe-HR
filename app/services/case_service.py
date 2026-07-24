from __future__ import annotations

import secrets
import string
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Case, ProcessingEvent, ProcessingStatus
from app.schemas import CaseCreate

CASE_ALPHABET = string.ascii_uppercase + string.digits


def generate_case_id(db: Session, now: datetime | None = None) -> str:
    date_part = (now or datetime.now(UTC)).strftime("%Y%m%d")
    for _ in range(100):
        candidate = f"SSF-{date_part}-{''.join(secrets.choice(CASE_ALPHABET) for _ in range(4))}"
        if db.scalar(select(Case.id).where(Case.case_id == candidate)) is None:
            return candidate
    raise RuntimeError("Unable to create a unique case ID")


def case_dir(settings: Settings, case_id: str) -> Path:
    if not case_id.startswith("SSF-") or any(
        char not in "-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" for char in case_id
    ):
        raise ValueError("Invalid case ID")
    return settings.cases_dir / case_id


def add_event(db: Session, case: Case, step: str, message: str, level: str = "INFO") -> None:
    db.add(ProcessingEvent(case_db_id=case.id, step=step, safe_message=message[:500], level=level))


def create_case(db: Session, data: CaseCreate, settings: Settings) -> Case:
    if not data.consent_accepted:
        raise ValueError("Consent is required before recording")
    case_id = generate_case_id(db)
    folder = case_dir(settings, case_id)
    (folder / "chunks").mkdir(parents=True, exist_ok=False)
    # These legacy database columns are intentionally blank. No employee identity is collected.
    case = Case(
        case_id=case_id,
        full_name="",
        employee_id="",
        department="",
        designation="",
        consent_accepted=True,
        recording_mime_type=data.recording_mime_type,
        processing_status=ProcessingStatus.RECORDING.value,
        current_step="Collecting recording",
    )
    db.add(case)
    db.flush()
    add_event(db, case, "Recording", "Anonymous case created; recording can begin.")
    db.commit()
    db.refresh(case)
    return case


def get_case_or_none(db: Session, case_id: str) -> Case | None:
    return db.scalar(select(Case).where(Case.case_id == case_id))


def set_status(db: Session, case: Case, status: ProcessingStatus, step: str, message: str) -> None:
    case.processing_status = status.value
    case.current_step = step
    add_event(db, case, step, message)
    db.commit()


def cancel_case(db: Session, case: Case) -> None:
    if case.processing_status in {ProcessingStatus.QUEUED.value, ProcessingStatus.COMPLETED.value}:
        raise ValueError("This case can no longer be cancelled")
    set_status(
        db, case, ProcessingStatus.CANCELLED, "Cancelled", "Recording was cancelled by employee."
    )
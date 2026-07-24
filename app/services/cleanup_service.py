from __future__ import annotations

import shutil
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Case, ProcessingStatus, utcnow
from app.services.case_service import case_dir


def cleanup_completed_cases(db: Session, settings: Settings) -> int:
    threshold = utcnow() - timedelta(hours=settings.local_retention_hours)
    cases = db.scalars(
        select(Case).where(
            Case.processing_status == ProcessingStatus.COMPLETED.value,
            Case.completed_at <= threshold,
            Case.local_cleanup_at.is_(None),
        )
    ).all()
    cleaned = 0
    for case in cases:
        # Completion means all Drive/Sheet work succeeded (or demo equivalents were saved).
        folder = case_dir(settings, case.case_id)
        if folder.exists():
            shutil.rmtree(folder)
        case.local_cleanup_at = utcnow()
        cleaned += 1
    db.commit()
    return cleaned

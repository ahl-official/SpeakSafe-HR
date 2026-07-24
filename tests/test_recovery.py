from __future__ import annotations

from datetime import timedelta
from io import BytesIO
from unittest.mock import Mock

import pytest
from test_core import payload

from app.models import ProcessingStatus, utcnow
from app.services.audio_service import AudioError, safe_chunk_path, store_chunk
from app.services.case_service import set_status
from app.services.cleanup_service import cleanup_completed_cases
from app.services.drive_service import DriveService
from app.services.pdf_service import report_context
from app.services.processing_service import QueueWorker


def test_chunk_index_is_validated(db, settings):
    case = __import__("app.services.case_service", fromlist=["create_case"]).create_case(
        db, payload(), settings
    )
    with pytest.raises(AudioError):
        safe_chunk_path(settings, case.case_id, 0, "audio/webm")


def test_duplicate_chunk_does_not_duplicate_file(db, settings):
    case = __import__("app.services.case_service", fromlist=["create_case"]).create_case(
        db, payload(), settings
    )
    assert store_chunk(settings, case, 1, "audio/webm", BytesIO(b"voice"))
    assert not store_chunk(settings, case, 1, "audio/webm", BytesIO(b"voice"))


def test_processing_status_transition_is_durable(db, settings):
    case = __import__("app.services.case_service", fromlist=["create_case"]).create_case(
        db, payload(), settings
    )
    set_status(db, case, ProcessingStatus.QUEUED, "Queued", "Ready for background processing.")
    assert case.processing_status == ProcessingStatus.QUEUED.value
    assert case.events[-1].step == "Queued"


def test_cleanup_removes_only_completed_case_folder(db, settings):
    case = __import__("app.services.case_service", fromlist=["create_case"]).create_case(
        db, payload(), settings
    )
    case.processing_status = ProcessingStatus.COMPLETED.value
    case.completed_at = utcnow() - timedelta(hours=settings.local_retention_hours + 1)
    db.commit()
    assert cleanup_completed_cases(db, settings) == 1
    assert not (settings.cases_dir / case.case_id).exists()


def test_demo_drive_retries_are_idempotent(settings, tmp_path):
    file = tmp_path / "recording.m4a"
    file.write_bytes(b"audio")
    drive = DriveService(settings)
    assert drive.upload("SSF-20260724-AB12", "audio", file) == drive.upload(
        "SSF-20260724-AB12", "audio", file
    )


def test_interrupted_case_is_recovered_by_worker(db, settings):
    case = __import__("app.services.case_service", fromlist=["create_case"]).create_case(
        db, payload(), settings
    )
    case.processing_status = ProcessingStatus.PROCESSING_AUDIO.value
    db.commit()
    service = Mock()
    worker = QueueWorker(lambda: db, service)
    worker.process_pending()
    service.process.assert_called_once_with(db, case)


def test_pdf_report_context_contains_transcript(db, settings):
    case = __import__("app.services.case_service", fromlist=["create_case"]).create_case(
        db, payload(), settings
    )
    context = report_context(case, {"feedback_category": "General"}, "hello", "today")
    assert context["case"].case_id == case.case_id
    assert context["transcript"] == "hello"

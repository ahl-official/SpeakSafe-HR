from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.database import Base
from app.models import ProcessingStatus
from app.schemas import CaseCreate, ReportData
from app.services.ai_report_service import fallback_report
from app.services.audio_service import AudioError, transcription_ranges, validate_expected_chunks
from app.services.case_service import create_case, generate_case_id
from app.services.sheets_service import HEADERS, SheetsService
from app.services.transcription_service import merge_transcripts, transcript_request


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", database_url=f"sqlite:///{tmp_path / 'test.db'}", demo_mode=True)


def payload(**changes):
    item = {"consent_accepted": True}
    item.update(changes)
    return CaseCreate(**item)


def test_case_id_is_unique_and_shaped(db):
    value = generate_case_id(db, datetime(2026, 7, 24, tzinfo=UTC))
    assert value.startswith("SSF-20260724-") and len(value) == 17


def test_case_requires_consent(db, settings):
    with pytest.raises(ValueError):
        create_case(db, payload(consent_accepted=False), settings)


def test_identity_fields_are_rejected():
    with pytest.raises(ValidationError):
        CaseCreate(consent_accepted=True, full_name="Asha Kumar")


def test_case_creation_creates_anonymous_chunk_folder(db, settings):
    case = create_case(db, payload(), settings)
    assert (settings.cases_dir / case.case_id / "chunks").is_dir()
    assert case.processing_status == ProcessingStatus.RECORDING.value
    assert (case.full_name, case.department, case.designation) == ("", "", "")


def test_finalize_missing_chunks_is_rejected(db, settings):
    case = create_case(db, payload(), settings)
    case.expected_chunk_count = 2
    db.commit()
    (settings.cases_dir / case.case_id / "chunks" / "000001.webm").write_bytes(b"x")
    with pytest.raises(AudioError):
        validate_expected_chunks(settings, case, 2)


def test_segment_ranges_have_overlap():
    assert transcription_ranges(1300, 10, 2) == [(0.0, 602), (600.0, 1202), (1200.0, 1300)]


def test_high_accuracy_multilingual_request(settings):
    request = transcript_request("https://example.invalid/audio", settings)
    assert request["speech_models"] == ["universal-3-pro"]
    assert request["language_detection"] is True
    assert "Hindi, Marathi and English" in str(request["prompt"])

def test_transcript_overlap_is_merged_without_rewrite():
    assert merge_transcripts(["I reported the issue yesterday", "yesterday and asked HR for support"]) == "I reported the issue yesterday and asked HR for support"


def test_report_validation_and_fallback():
    report = fallback_report("anything")
    assert isinstance(report, ReportData) and report.urgency == "Normal"


def test_anonymous_sheet_has_no_employee_columns():
    assert not {"Full Name", "Department", "Designation", "Employee ID"}.intersection(HEADERS)


def test_demo_sheet_upsert_is_idempotent(settings):
    sheets = SheetsService(settings)
    row = {"Case ID": "SSF-20260724-AB12", "Professional Summary": "First summary"}
    assert sheets.upsert(row) == 2
    row["Professional Summary"] = "Updated summary"
    assert sheets.upsert(row) == 2
    assert settings.demo_csv_path.read_text(encoding="utf-8").count("SSF-20260724-AB12") == 1
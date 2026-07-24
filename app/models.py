from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ProcessingStatus(str, Enum):
    DRAFT = "Draft"
    RECORDING = "Recording"
    QUEUED = "Queued"
    PROCESSING_AUDIO = "Processing Audio"
    UPLOADING_AUDIO = "Uploading Audio"
    TRANSCRIBING = "Transcribing"
    GENERATING_REPORT = "Generating AI Report"
    GENERATING_PDF = "Generating PDF"
    UPLOADING_TRANSCRIPT = "Uploading Transcript"
    UPLOADING_PDF = "Uploading PDF"
    UPDATING_SHEET = "Updating Google Sheet"
    COMPLETED = "Completed"
    FAILED = "Failed"
    RETRY_PENDING = "Retry Pending"
    CANCELLED = "Cancelled"


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class Case(Base):
    __tablename__ = "cases"
    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    full_name: Mapped[str] = mapped_column(String(160))
    employee_id: Mapped[str] = mapped_column(String(80))
    department: Mapped[str] = mapped_column(String(100))
    designation: Mapped[str] = mapped_column(String(120))
    consent_accepted: Mapped[bool] = mapped_column(Boolean, default=False)
    recording_mime_type: Mapped[str] = mapped_column(String(100), default="audio/webm")
    recording_duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    expected_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    received_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    local_source_audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_processed_audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_transcript_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_pdf_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    processing_status: Mapped[str] = mapped_column(String(40), default=ProcessingStatus.DRAFT.value)
    current_step: Mapped[str] = mapped_column(String(80), default="Created")
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    drive_audio_file_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    drive_audio_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    drive_transcript_file_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    drive_transcript_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    drive_pdf_file_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    drive_pdf_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    sheet_row_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    report_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    local_cleanup_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    segments: Mapped[list[TranscriptionSegment]] = relationship(
        back_populates="case", cascade="all, delete-orphan"
    )
    events: Mapped[list[ProcessingEvent]] = relationship(
        back_populates="case", cascade="all, delete-orphan"
    )


class TranscriptionSegment(Base):
    __tablename__ = "transcription_segments"
    __table_args__ = (
        UniqueConstraint("case_db_id", "segment_index", name="uq_segment_case_index"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    case_db_id: Mapped[int] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    segment_index: Mapped[int] = mapped_column(Integer)
    start_seconds: Mapped[float] = mapped_column(Float)
    end_seconds: Mapped[float] = mapped_column(Float)
    local_segment_path: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="Pending")
    transcript_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    case: Mapped[Case] = relationship(back_populates="segments")


class ProcessingEvent(Base):
    __tablename__ = "processing_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    case_db_id: Mapped[int] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    step: Mapped[str] = mapped_column(String(80))
    level: Mapped[str] = mapped_column(String(20), default="INFO")
    safe_message: Mapped[str] = mapped_column(String(500))
    case: Mapped[Case] = relationship(back_populates="events")

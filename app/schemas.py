from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CaseCreate(BaseModel):
    """Anonymous case creation: only informed consent and recording format are collected."""

    model_config = ConfigDict(extra="forbid")

    consent_accepted: bool
    recording_mime_type: str = Field(default="audio/webm", max_length=100)


class FinalizeRequest(BaseModel):
    expected_chunk_count: int = Field(ge=1, le=10000)
    duration_seconds: float = Field(gt=0, le=10800)


class CaseResponse(BaseModel):
    case_id: str
    status: str


class ReportData(BaseModel):
    feedback_category: str
    professional_summary: str
    key_points: list[str]
    people_or_roles_mentioned: list[str]
    dates_or_time_references: list[str]
    workplace_impact: str
    support_requested: str
    urgency: Literal["Normal", "Important", "Urgent", "Immediate Safety Concern"]
    safety_concern: str
    information_not_clear: str


class RecordingStatus(BaseModel):
    case_id: str
    received_chunk_count: int
    expected_chunk_count: int
    processing_status: str
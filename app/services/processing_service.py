from __future__ import annotations

import asyncio
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Case, ProcessingStatus, TranscriptionSegment, utcnow
from app.services.ai_report_service import DISCLAIMER, ReportGenerator, fallback_report
from app.services.audio_service import AudioError, create_segments, finalize_audio
from app.services.case_service import case_dir, set_status
from app.services.drive_service import DriveService
from app.services.pdf_service import create_pdf_sync, report_context
from app.services.sheets_service import SheetsService
from app.services.transcription_service import AssemblyAITranscriber, merge_transcripts

RETRYABLE = (AudioError, RuntimeError, OSError)


class ProcessingService:
    def __init__(self, settings: Settings, template_dir: Path) -> None:
        self.settings = settings
        self.template_dir = template_dir
        self.transcriber = AssemblyAITranscriber(settings)
        self.report_generator = ReportGenerator(settings)
        self.drive = DriveService(settings)
        self.sheets = SheetsService(settings)

    def _save(
        self, db: Session, case: Case, status: ProcessingStatus, step: str, message: str
    ) -> None:
        set_status(db, case, status, step, message)

    def process(self, db: Session, case: Case) -> None:
        try:
            self._process(db, case)
        except RETRYABLE as exc:
            case.retry_count += 1
            case.last_error = type(exc).__name__
            if case.retry_count >= 5:
                self._save(
                    db,
                    case,
                    ProcessingStatus.FAILED,
                    "Failed",
                    "Processing needs administrator review.",
                )
            else:
                self._save(
                    db,
                    case,
                    ProcessingStatus.RETRY_PENDING,
                    "Retry pending",
                    "A temporary processing step will be retried.",
                )

    def _process(self, db: Session, case: Case) -> None:
        folder = case_dir(self.settings, case.case_id)
        # A completed case can be explicitly repaired when its local source is recovered.
        replace_existing_drive_files = case.completed_at is not None
        if not case.local_processed_audio_path:
            self._save(
                db,
                case,
                ProcessingStatus.PROCESSING_AUDIO,
                "Processing audio",
                "Normalizing audio locally.",
            )
            source, processed, duration = finalize_audio(self.settings, case)
            case.local_source_audio_path, case.local_processed_audio_path = (
                str(source),
                str(processed),
            )
            case.recording_duration_seconds = duration
            db.commit()
        processed_path = Path(case.local_processed_audio_path or "")
        if not case.drive_audio_file_id:
            self._save(
                db,
                case,
                ProcessingStatus.UPLOADING_AUDIO,
                "Uploading audio",
                "Saving audio to the authorized HR folder.",
            )
            case.drive_audio_file_id, case.drive_audio_link = self.drive.upload(
                case.case_id, "audio", processed_path, replace_existing=replace_existing_drive_files
            )
            db.commit()
        if not case.local_transcript_path:
            self._save(
                db,
                case,
                ProcessingStatus.TRANSCRIBING,
                "Transcribing",
                "Transcribing recording in chronological segments.",
            )
            segments = create_segments(
                self.settings, case, processed_path, case.recording_duration_seconds or 0
            )
            existing = {segment.segment_index: segment for segment in case.segments}
            for index, start, end, path in segments:
                segment = existing.get(index)
                if not segment:
                    segment = TranscriptionSegment(
                        case_db_id=case.id,
                        segment_index=index,
                        start_seconds=start,
                        end_seconds=end,
                        local_segment_path=str(path),
                    )
                    db.add(segment)
                    db.commit()
                if not segment.transcript_text:
                    text = self.transcriber.transcribe(path)
                    segment.transcript_text, segment.status, segment.completed_at = (
                        text,
                        "Completed",
                        utcnow(),
                    )
                    (folder / f"segment-{index:03d}.txt").write_text(text, encoding="utf-8")
                    db.commit()
            ordered = db.scalars(
                select(TranscriptionSegment)
                .where(TranscriptionSegment.case_db_id == case.id)
                .order_by(TranscriptionSegment.segment_index)
            ).all()
            transcript = merge_transcripts([segment.transcript_text or "" for segment in ordered])
            transcript_path = folder / f"{case.case_id}-transcript.txt"
            transcript_path.write_text(transcript, encoding="utf-8")
            case.local_transcript_path = str(transcript_path)
            db.commit()
        transcript_path = Path(case.local_transcript_path or "")
        transcript = transcript_path.read_text(encoding="utf-8")
        if not case.report_json:
            self._save(
                db,
                case,
                ProcessingStatus.GENERATING_REPORT,
                "Generating AI report",
                "Preparing a neutral HR intake report.",
            )
            try:
                report = self.report_generator.generate(transcript)
                report_status = "Generated"
            except Exception:
                report = fallback_report(transcript)
                report_status = "Unavailable; fallback report generated"
            payload = report.model_dump() | {"disclaimer": DISCLAIMER, "status": report_status}
            case.report_json = json.dumps(payload, ensure_ascii=False)
            db.commit()
        report_data = json.loads(case.report_json)
        if not case.local_pdf_path:
            self._save(
                db,
                case,
                ProcessingStatus.GENERATING_PDF,
                "Generating PDF",
                "Creating local PDF report.",
            )
            pdf_path = folder / f"{case.case_id}-report.pdf"
            submitted = case.submitted_at or case.created_at
            display = (
                submitted.replace(tzinfo=ZoneInfo("UTC"))
                .astimezone(ZoneInfo(self.settings.app_timezone))
                .strftime("%d %b %Y, %I:%M %p IST")
            )
            create_pdf_sync(
                self.template_dir, pdf_path, report_context(case, report_data, transcript, display)
            )
            case.local_pdf_path = str(pdf_path)
            db.commit()
        if not case.drive_transcript_file_id:
            self._save(
                db,
                case,
                ProcessingStatus.UPLOADING_TRANSCRIPT,
                "Uploading transcript",
                "Saving transcript to the authorized HR folder.",
            )
            case.drive_transcript_file_id, case.drive_transcript_link = self.drive.upload(
                case.case_id, "transcript", transcript_path, replace_existing=replace_existing_drive_files
            )
            db.commit()
        if not case.drive_pdf_file_id:
            self._save(
                db,
                case,
                ProcessingStatus.UPLOADING_PDF,
                "Uploading PDF",
                "Saving PDF report to the authorized HR folder.",
            )
            case.drive_pdf_file_id, case.drive_pdf_link = self.drive.upload(
                case.case_id,
                "report",
                Path(case.local_pdf_path or ""),
                replace_existing=replace_existing_drive_files,
            )
            db.commit()
        self._save(
            db,
            case,
            ProcessingStatus.UPDATING_SHEET,
            "Updating feedback register",
            "Updating the secure feedback register.",
        )
        if not case.sheet_row_number:
            report = report_data
            submitted = case.submitted_at or case.created_at
            display = (
                submitted.replace(tzinfo=ZoneInfo("UTC"))
                .astimezone(ZoneInfo(self.settings.app_timezone))
                .strftime("%Y-%m-%d %H:%M IST")
            )
            row = {
                "Case ID": case.case_id,
                "Submitted At": display,
                "Recording Duration": f"{round(case.recording_duration_seconds or 0)} seconds",
                "Feedback Category": report["feedback_category"],
                "Professional Summary": report["professional_summary"],
                "Key Points": "- " + "\n- ".join(report["key_points"]),
                "People or Roles Mentioned": ", ".join(report["people_or_roles_mentioned"]),
                "Dates or Time References": ", ".join(report["dates_or_time_references"]),
                "Workplace Impact": report["workplace_impact"],
                "Support Requested": report["support_requested"],
                "Urgency": report["urgency"],
                "Safety Concern": report["safety_concern"],
                "Information Not Clear": report["information_not_clear"],
                "Audio Recording": case.drive_audio_link or "",
                "Full Transcript": case.drive_transcript_link or "",
                "PDF Report": case.drive_pdf_link or "",
                "Processing Status": "Completed",
                "HR Status": "New",
                "Last Updated": display,
            }
            case.sheet_row_number = self.sheets.upsert(row)
            db.commit()
        case.completed_at, case.last_error = utcnow(), None
        self._save(db, case, ProcessingStatus.COMPLETED, "Completed", "Case processing completed.")


class QueueWorker:
    def __init__(self, session_factory, service: ProcessingService) -> None:
        self.session_factory, self.service = session_factory, service
        self.running = False
        self.task: asyncio.Task | None = None

    async def start(self) -> None:
        self.running = True
        self.task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        while self.running:
            await asyncio.to_thread(self.process_pending)
            await asyncio.sleep(4)

    def process_pending(self) -> None:
        db: Session = self.session_factory()
        try:
            recoverable = [
                ProcessingStatus.QUEUED.value,
                ProcessingStatus.RETRY_PENDING.value,
                ProcessingStatus.PROCESSING_AUDIO.value,
                ProcessingStatus.UPLOADING_AUDIO.value,
                ProcessingStatus.TRANSCRIBING.value,
                ProcessingStatus.GENERATING_REPORT.value,
                ProcessingStatus.GENERATING_PDF.value,
                ProcessingStatus.UPLOADING_TRANSCRIPT.value,
                ProcessingStatus.UPLOADING_PDF.value,
                ProcessingStatus.UPDATING_SHEET.value,
            ]
            cases = db.scalars(
                select(Case)
                .where(Case.processing_status.in_(recoverable))
                .order_by(Case.created_at)
                .limit(2)
            ).all()
            for case in cases:
                self.service.process(db, case)
        finally:
            db.close()

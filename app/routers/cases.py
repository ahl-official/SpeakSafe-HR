from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import ProcessingStatus
from app.schemas import CaseCreate, CaseResponse, FinalizeRequest, RecordingStatus
from app.services.audio_service import AudioError, store_async_chunk, validate_expected_chunks
from app.services.case_service import cancel_case, create_case, get_case_or_none, set_status

router = APIRouter(prefix="/api/cases", tags=["cases"])


def find_case(db: Session, case_id: str):
    case = get_case_or_none(db, case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


@router.post("", response_model=CaseResponse, status_code=status.HTTP_201_CREATED)
def create_case_endpoint(payload: CaseCreate, db: Session = Depends(get_db)) -> CaseResponse:
    try:
        case = create_case(db, payload, get_settings())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return CaseResponse(case_id=case.case_id, status=case.processing_status)


@router.post("/{case_id}/chunks/{chunk_index}")
async def upload_chunk(
    case_id: str, chunk_index: int, request: Request, db: Session = Depends(get_db)
) -> dict[str, int | bool]:
    case = find_case(db, case_id)
    if case.processing_status != ProcessingStatus.RECORDING.value:
        raise HTTPException(status_code=409, detail="Recording is not accepting new chunks")
    try:
        stored = await store_async_chunk(
            get_settings(),
            case,
            chunk_index,
            request.headers.get("content-type", ""),
            request.stream(),
        )
    except (AudioError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # request.stream yields async chunks, use streaming conversion only in endpoint below
    if stored:
        case.received_chunk_count += 1
        db.commit()
    return {"chunk_index": chunk_index, "stored": stored}


@router.post("/{case_id}/finalize", response_model=CaseResponse)
def finalize_case(
    case_id: str, payload: FinalizeRequest, db: Session = Depends(get_db)
) -> CaseResponse:
    case = find_case(db, case_id)
    if case.processing_status == ProcessingStatus.QUEUED.value:
        return CaseResponse(case_id=case.case_id, status=case.processing_status)
    if case.processing_status != ProcessingStatus.RECORDING.value:
        raise HTTPException(status_code=409, detail="This recording cannot be submitted")
    try:
        case.expected_chunk_count = payload.expected_chunk_count
        validate_expected_chunks(get_settings(), case, payload.expected_chunk_count)
    except AudioError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    case.recording_duration_seconds = payload.duration_seconds
    case.submitted_at = __import__("app.models", fromlist=["utcnow"]).utcnow()
    set_status(
        db, case, ProcessingStatus.QUEUED, "Queued", "Recording submitted for private processing."
    )
    return CaseResponse(case_id=case.case_id, status=case.processing_status)


@router.post("/{case_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
def cancel_case_endpoint(case_id: str, db: Session = Depends(get_db)) -> Response:
    case = find_case(db, case_id)
    try:
        cancel_case(db, case)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{case_id}/recording-status", response_model=RecordingStatus)
def recording_status(case_id: str, db: Session = Depends(get_db)) -> RecordingStatus:
    case = find_case(db, case_id)
    return RecordingStatus(
        case_id=case.case_id,
        received_chunk_count=case.received_chunk_count,
        expected_chunk_count=case.expected_chunk_count,
        processing_status=case.processing_status,
    )

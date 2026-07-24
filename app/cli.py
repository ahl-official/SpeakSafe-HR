from __future__ import annotations

import argparse
from pathlib import Path

from sqlalchemy import select

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.models import Case, ProcessingStatus
from app.services.cleanup_service import cleanup_completed_cases
from app.services.google_auth_service import authorize_google
from app.services.processing_service import ProcessingService


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-pending")
    retry = sub.add_parser("retry-failed")
    retry.add_argument("--case-id")
    sub.add_parser("google-auth")
    sub.add_parser("cleanup")
    sub.add_parser("anonymize-existing")
    args = parser.parse_args()
    settings = get_settings()
    settings.prepare_directories()
    init_db()
    if args.command == "google-auth":
        print(authorize_google(settings))
        return
    db = SessionLocal()
    try:
        if args.command == "list-pending":
            statuses = [
                ProcessingStatus.QUEUED.value,
                ProcessingStatus.RETRY_PENDING.value,
                ProcessingStatus.FAILED.value,
            ]
            for case in db.scalars(
                select(Case).where(Case.processing_status.in_(statuses)).order_by(Case.created_at)
            ):
                print(f"{case.case_id:22} {case.processing_status:15} {case.current_step}")
        elif args.command == "anonymize-existing":
            cases = db.scalars(select(Case)).all()
            for case in cases:
                case.full_name = ""
                case.employee_id = ""
                case.department = ""
                case.designation = ""
            db.commit()
            print(f"Cleared legacy profile fields for {len(cases)} case(s).")
        elif args.command == "retry-failed":
            q = select(Case).where(
                Case.processing_status.in_(
                    [ProcessingStatus.FAILED.value, ProcessingStatus.RETRY_PENDING.value]
                )
            )
            if args.case_id:
                q = q.where(Case.case_id == args.case_id)
            cases = db.scalars(q).all()
            for case in cases:
                case.processing_status = ProcessingStatus.QUEUED.value
                case.last_error = None
            db.commit()
            service = ProcessingService(settings, Path(__file__).parent / "templates")
            for case in cases:
                service.process(db, case)
                print(f"{case.case_id}: {case.processing_status}")
        else:
            print(f"Cleaned {cleanup_completed_cases(db, settings)} completed case folder(s).")
    finally:
        db.close()


if __name__ == "__main__":
    main()

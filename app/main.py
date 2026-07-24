from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import get_settings
from app.database import SessionLocal, init_db
from app.routers.cases import router as cases_router
from app.services.processing_service import ProcessingService, QueueWorker

settings = get_settings()
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
worker: QueueWorker | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global worker
    settings.prepare_directories()
    missing = settings.validate_live_configuration()
    if missing:
        raise RuntimeError("Live mode configuration missing: " + ", ".join(missing))
    init_db()
    worker = QueueWorker(
        SessionLocal, ProcessingService(settings, Path(__file__).parent / "templates")
    )
    await worker.start()
    yield
    await worker.stop()


app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")
app.include_router(cases_router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self';"
    )
    return response


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "index.html",
        {"max_minutes": settings.max_recording_minutes},
    )


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "mode": "demo" if settings.demo_mode else "live"})

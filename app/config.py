from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_DEPARTMENTS = [
    "AI",
    "CRM",
    "Colour Inventory",
    "Consultant",
    "Content Creation",
    "Customer Support",
    "Digital Marketing",
    "Editor",
    "Finance",
    "Graphic Designer",
    "HR",
    "Inventory",
    "MIS",
    "Performance Marketing",
    "Process Coordinator",
    "Sales",
    "UI/UX",
    "Other",
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "SpeakSafe HR"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    app_timezone: str = "Asia/Kolkata"
    demo_mode: bool = True
    database_url: str = "sqlite:///data/database/speaksafe.db"
    data_dir: Path = Path("data")
    max_recording_minutes: int = Field(default=60, ge=1, le=180)
    audio_bitrate_kbps: int = Field(default=64, ge=16, le=256)
    transcription_segment_minutes: int = Field(default=10, ge=1, le=60)
    transcription_overlap_seconds: int = Field(default=2, ge=0, le=30)
    local_retention_hours: int = Field(default=24, ge=1)
    assemblyai_api_key: str = ""
    assemblyai_base_url: str = "https://api.assemblyai.com/v2"
    assemblyai_speech_model: str = "universal-3-pro"
    assemblyai_language_detection: bool = True
    assemblyai_transcription_prompt: str = (
        "Transcribe verbatim in Hindi, Marathi and English. Support Hinglish and "
        "mid-sentence language switching. Preserve the language spoken, proper names, "
        "numbers and incidents. Do not translate, summarize or rewrite the statement."
    )
    openrouter_api_key: str = ""
    openrouter_model: str = "openai/gpt-4o-mini"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    apps_script_webhook_url: str = ""
    apps_script_shared_secret: str = ""
    google_oauth_client_file: str = ""
    google_token_file: Path = Path("data/oauth/token.json")
    google_drive_root_folder_id: str = ""
    google_sheet_id: str = ""
    google_sheet_tab_name: str = "Employee Feedback Reports"
    upload_chunk_size_mb: int = Field(default=8, ge=1, le=64)
    log_level: str = "INFO"

    @field_validator("app_host")
    @classmethod
    def localhost_only(cls, value: str) -> str:
        if value not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("APP_HOST must be a localhost address")
        return value

    @property
    def cases_dir(self) -> Path:
        return self.data_dir / "cases"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def database_dir(self) -> Path:
        return self.data_dir / "database"

    @property
    def demo_csv_path(self) -> Path:
        return self.data_dir / "demo_feedback_reports.csv"

    def prepare_directories(self) -> None:
        for folder in (
            self.data_dir,
            self.cases_dir,
            self.logs_dir,
            self.database_dir,
            self.google_token_file.parent,
        ):
            folder.mkdir(parents=True, exist_ok=True)

    def validate_live_configuration(self) -> list[str]:
        if self.demo_mode:
            return []
        required = {
            "ASSEMBLYAI_API_KEY": self.assemblyai_api_key,
            "OPENROUTER_API_KEY": self.openrouter_api_key,
            "APPS_SCRIPT_WEBHOOK_URL": self.apps_script_webhook_url,
            "APPS_SCRIPT_SHARED_SECRET": self.apps_script_shared_secret,
        }
        return [name for name, value in required.items() if not value]


@lru_cache
def get_settings() -> Settings:
    return Settings()

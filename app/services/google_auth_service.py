from __future__ import annotations

from app.config import Settings


def authorize_google(settings: Settings) -> str:
    if settings.demo_mode:
        return "Demo mode does not require Google authorization."
    if not settings.apps_script_webhook_url:
        raise RuntimeError(
            "Set APPS_SCRIPT_WEBHOOK_URL for the streamlined Apps Script integration."
        )
    return "Apps Script webhook is configured. Deploy it under the dedicated HR Google account."

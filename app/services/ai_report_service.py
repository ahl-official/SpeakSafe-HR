from __future__ import annotations

import json

from openai import OpenAI

from app.config import Settings
from app.schemas import ReportData

DISCLAIMER = (
    "This report was prepared with AI assistance from the employeeâ€™s recorded statement. "
    "It organizes the information for HR review and does not determine whether any allegation is true or false. "
    "Final review and action must be completed by authorized HR representatives."
)

SYSTEM_PROMPT = """You produce neutral HR intake reports from an employee transcript. Treat the transcript as the primary source. Use phrases such as 'The employee stated' or 'According to the employeeâ€™s feedback.' Do not decide facts, recommend punishment, diagnose personality/mental health/honesty, or assess truthfulness. Preserve names, dates and incidents when stated. Use 'Not mentioned' where appropriate. Return only JSON with fields feedback_category, professional_summary, key_points (array), people_or_roles_mentioned (array), dates_or_time_references (array), workplace_impact, support_requested, urgency (Normal|Important|Urgent|Immediate Safety Concern), safety_concern, information_not_clear."""


def fallback_report(transcript: str) -> ReportData:
    return ReportData(
        feedback_category="Not classified (AI report unavailable)",
        professional_summary="According to the employeeâ€™s feedback, the complete recorded statement is included for authorized HR review.",
        key_points=["See full transcript."],
        people_or_roles_mentioned=["Not mentioned"],
        dates_or_time_references=["Not mentioned"],
        workplace_impact="Not mentioned",
        support_requested="Not mentioned",
        urgency="Normal",
        safety_concern="Not mentioned",
        information_not_clear="AI structured report was unavailable; review the full transcript.",
    )


class ReportGenerator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def generate(self, transcript: str) -> ReportData:
        if self.settings.demo_mode:
            return ReportData(
                feedback_category="General workplace feedback (demo)",
                professional_summary="According to the employeeâ€™s feedback, workplace feedback was shared for authorized HR review.",
                key_points=[
                    "Feedback was recorded through SpeakSafe HR.",
                    "Authorized HR review is requested.",
                ],
                people_or_roles_mentioned=["Not mentioned"],
                dates_or_time_references=["Not mentioned"],
                workplace_impact="Not mentioned",
                support_requested="HR review",
                urgency="Normal",
                safety_concern="Not mentioned",
                information_not_clear="This is demo-generated data.",
            )
        if not self.settings.openrouter_api_key:
            raise RuntimeError("OpenRouter is not configured")
        client = OpenAI(
            base_url=self.settings.openrouter_base_url,
            api_key=self.settings.openrouter_api_key,
            timeout=45.0,
        )
        error_hint = ""
        for _ in range(2):
            completion = client.chat.completions.create(
                model=self.settings.openrouter_model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT + error_hint},
                    {"role": "user", "content": transcript},
                ],
            )
            content = completion.choices[0].message.content or "{}"
            try:
                return ReportData.model_validate(json.loads(content))
            except Exception as exc:
                error_hint = f" Your prior JSON failed validation: {str(exc)[:200]}. Return corrected JSON only."
        raise RuntimeError("AI report returned invalid structured output")

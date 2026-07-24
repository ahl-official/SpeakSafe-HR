from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.async_api import async_playwright


def report_context(case, report, transcript: str, submitted_display: str) -> dict[str, Any]:
    return {
        "case": case,
        "report": report,
        "transcript": transcript,
        "submitted_display": submitted_display,
    }


async def create_pdf(template_dir: Path, output_path: Path, context: dict[str, Any]) -> None:
    environment = Environment(
        loader=FileSystemLoader(template_dir), autoescape=select_autoescape(["html"])
    )
    html = environment.get_template("report.html").render(**context)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        try:
            page = await browser.new_page()
            await page.set_content(html, wait_until="networkidle")
            await page.pdf(
                path=str(output_path),
                format="A4",
                print_background=True,
                margin={"top": "17mm", "right": "15mm", "bottom": "18mm", "left": "15mm"},
                display_header_footer=True,
                footer_template=f'<div style="font-size:8px;width:100%;text-align:center;color:#5b677a">{context["case"].case_id} Â· Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
            )
        finally:
            await browser.close()


def create_pdf_sync(template_dir: Path, output_path: Path, context: dict[str, Any]) -> None:
    asyncio.run(create_pdf(template_dir, output_path, context))

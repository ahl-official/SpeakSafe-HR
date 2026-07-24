@echo off
setlocal
cd /d "%~dp0"
py -3.11 -m venv .venv || python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -e ".[dev]"
python -m playwright install chromium
where ffmpeg >nul 2>nul && echo FFmpeg found || echo WARNING: FFmpeg not found. Install it and add it to PATH.
where ffprobe >nul 2>nul && echo FFprobe found || echo WARNING: FFprobe not found. Install it and add it to PATH.
if not exist .env copy .env.example .env
echo.
echo Setup complete. Edit .env if you need live integrations, then run run.bat.
pause

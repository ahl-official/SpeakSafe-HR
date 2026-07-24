@echo off
setlocal
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup.bat first.& pause & exit /b 1)
call .venv\Scripts\activate.bat
if not exist .env copy .env.example .env
start "SpeakSafe HR" http://127.0.0.1:8000
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

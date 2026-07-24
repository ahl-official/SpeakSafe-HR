@echo off
setlocal
cd /d "%~dp0"
where python || echo Python: NOT FOUND
if exist .venv\Scripts\python.exe (echo Virtual environment: OK) else echo Virtual environment: NOT FOUND
where ffmpeg || echo FFmpeg: NOT FOUND
where ffprobe || echo FFprobe: NOT FOUND
if exist .venv\Scripts\playwright.exe (echo Playwright: OK) else echo Playwright: run setup.bat
if exist .env (echo .env: OK) else echo .env: copy .env.example to .env
if exist data (echo Data directory: OK) else echo Data directory: will be created on start
pause

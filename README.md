# SpeakSafe HR

SpeakSafe HR is a local, private employee-feedback application for one Windows laptop. Employees can submit **anonymous voice feedback** in a browser. The application stores the recording, creates a transcript and neutral HR report, makes a PDF, then places the audio, transcript and PDF in a restricted Google Drive folder and one structured Google Sheet row.

The application runs only on the laptop at:

```text
http://127.0.0.1:8000
```

It is not a public website and does not bind to the office network or internet.

## Run in 3 steps

After the first-time setup is complete:

1. Double-click `run.bat`.
2. Open `http://127.0.0.1:8000` if the browser does not open automatically.
3. Keep the Command Prompt window running while employees use the application. To stop it, press `Ctrl + C` in that window.

For the very first setup, run `setup.bat` before `run.bat`. See [First-time local setup](#first-time-local-setup) for the full instructions.
## What employees see

1. A short privacy and consent screen. No name, employee ID, department or role is requested.
2. One professional feedback question.
3. Start, pause, continue and stop voice-recording controls.
4. A playback review before submission.
5. A confirmation screen with a unique Case ID, such as `SSF-20260724-A7K2`.

After the Case ID confirmation appears, the employee can close the browser tab safely. Processing continues in the local background worker.

## What HR receives

For every completed case, Google Drive receives:

- `SSF-YYYYMMDD-XXXX-audio.m4a`
- `SSF-YYYYMMDD-XXXX-transcript.txt`
- `SSF-YYYYMMDD-XXXX-report.pdf`

The Google Sheet receives one row per Case ID with:

- Case ID and submission time
- Recording duration
- Neutral HR report fields
- Clickable Audio, Full Transcript and PDF links
- Processing Status and HR review fields

The PDF contains the HR report summary and review details. It deliberately **does not print the full transcript**. The full transcript is kept as its own restricted Drive file.

## Storage ownership and access

All live Google resources must be owned by the **dedicated HR Google account**, not an individual employee account.

- **Drive root folder:** `SpeakSafe HR - Restricted HR Records`
- **Google Sheet file:** `Employee Feedback Reports`
- **Sheet tab:** `Employee Feedback Reports`
- **Owner:** the dedicated HR Google account that deployed the Apps Script web app

Each Case ID has exactly one Sheet row. The row contains secure clickable links labelled **Open** for:

1. Audio Recording in Drive
2. Full Transcript in Drive
3. PDF Report in Drive

The Apps Script stores Drive files under the restricted root folder in organised paths such as `Audio Recordings/2026/July`. It finds files and Sheet rows by Case ID, so normal retries update the same row instead of creating duplicates.

Only users who already have access to the restricted Drive folder and Sheet can open the files. Do not make links public or use â€œAnyone with the link.â€
## Privacy model

- New cases collect no identity fields. The API rejects name, department, designation and employee-ID input.
- The database keeps the old technical columns for compatibility, but new anonymous cases store them as blank values.
- Audio/transcript content can naturally contain names if a speaker says them. The app does not automatically redact spoken content because that could alter an employee statement.
- Audio, transcript and PDF files are restricted by the permissions of the parent Drive folder. The app does not create public links.
- API keys, Apps Script secrets, recordings, transcripts, PDFs, database files and logs are ignored by Git.

## Architecture

```text
Employee browser
  -> FastAPI on 127.0.0.1:8000
  -> five-second recording chunks saved locally
  -> SQLite durable queue
  -> FFmpeg / FFprobe normalise audio
  -> AssemblyAI transcribes audio segments
  -> OpenRouter creates a neutral structured HR report
  -> Playwright Chromium creates the PDF
  -> Google Apps Script stores files in Drive and updates Google Sheets
```

The browser sends each recording chunk sequentially while recording continues. The complete recording is therefore not kept only in browser memory.

When the employee submits, the app creates a durable SQLite job immediately. The browser does not wait for external uploads, transcription or PDF generation.

## Technology stack

| Area | Technology |
|---|---|
| Local web app | Python 3.11+, FastAPI, Uvicorn, Jinja2 |
| Interface | HTML, CSS, vanilla JavaScript, MediaRecorder API |
| Durable storage | SQLite and SQLAlchemy 2.x |
| Audio | FFmpeg and FFprobe |
| Speech-to-text | AssemblyAI pre-recorded transcription API |
| HR report | OpenRouter with `openai/gpt-4o-mini` by default |
| PDF | Playwright with Chromium |
| Google integration | Google Apps Script web app, Google Drive and Google Sheets |
| Quality checks | Pytest, Ruff and MyPy |

## Project layout

```text
app/                    FastAPI routes, services, templates and static files
apps_script/Code.gs     Google Apps Script integration
data/                   Runtime data: database, recordings, transcripts and PDFs
  database/
  cases/
  logs/
tests/                  Automated tests
.env                    Local secrets and settings; never commit this
.env.example            Safe configuration example
setup.bat               First-time Windows setup
run.bat                 Start the local application
run_dev.bat             Start with auto-reload for development
check_system.bat        Check Python, FFmpeg, Playwright and configuration
```

## Requirements

Install these on the Windows laptop:

1. **Python 3.11 or newer**
2. **FFmpeg and FFprobe**, both available in `PATH`
3. A modern Chromium-based browser, such as Google Chrome or Microsoft Edge
4. Internet access while AssemblyAI, OpenRouter, Drive and Sheets processing is required

The browser needs microphone permission for `http://127.0.0.1:8000`.

## First-time local setup

1. Open the project folder.
2. Double-click `setup.bat`.
3. It creates `.venv`, installs Python packages and installs Playwright Chromium.
4. Copy `.env.example` to `.env` if `.env` is not already present.
5. Complete the live-service values in `.env`.

From Command Prompt, the equivalent setup is:

```bat
python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -e .
python -m playwright install chromium
```

Check the machine at any time:

```bat
check_system.bat
```

## Configuration

Never place keys in source code, batch files, the Google Sheet, or messages. Put them only in `.env`.

```ini
APP_NAME=SpeakSafe HR
APP_HOST=127.0.0.1
APP_PORT=8000
APP_TIMEZONE=Asia/Kolkata

DEMO_MODE=false
DATABASE_URL=sqlite:///data/database/speaksafe.db
DATA_DIR=data

MAX_RECORDING_MINUTES=60
AUDIO_BITRATE_KBPS=64
TRANSCRIPTION_SEGMENT_MINUTES=10
TRANSCRIPTION_OVERLAP_SECONDS=2
LOCAL_RETENTION_HOURS=24

ASSEMBLYAI_API_KEY=your_assemblyai_key
ASSEMBLYAI_BASE_URL=https://api.assemblyai.com/v2

OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=openai/gpt-4o-mini

APPS_SCRIPT_WEBHOOK_URL=https://script.google.com/macros/s/your_deployment/exec
APPS_SCRIPT_SHARED_SECRET=your_long_random_secret

LOG_LEVEL=INFO
```

### Recording limits

- The default maximum recording time is 60 minutes.
- A warning appears at 55 minutes.
- Recording stops at 60 minutes.
- Audio is normalised to a compact mono format before transcription and Drive upload.
- Long recordings are segmented into ten-minute transcription requests with a two-second overlap.

## Google Drive and Google Sheet setup

This version intentionally uses **Google Apps Script** instead of a local Google Cloud OAuth project. It is simpler for one dedicated HR Google account.

### Create the Google resources

Under the dedicated HR Google account, create:

- One restricted Drive folder, for example: `SpeakSafe HR - Restricted HR Records`
- One Google Sheet, for example: `Employee Feedback Reports`

Share both only with authorised HR staff. Do not enable â€œAnyone with the link.â€

Copy your Drive folder ID and Google Sheet ID into the two placeholder values at the top of [apps_script/Code.gs](apps_script/Code.gs). Do not commit your configured IDs back to GitHub.

### Deploy Apps Script

1. Open <https://script.google.com> while signed in to the HR Google account.
2. Create a new Apps Script project.
3. Copy all content from [apps_script/Code.gs](apps_script/Code.gs) into the editor and save.
4. In the editor, run `setupSpeakSafe()` once and approve Google permissions.
   - It creates/reuses `Audio Recordings`, `Transcripts` and `PDF Reports` folders.
   - It creates/formats the `Employee Feedback Reports` tab.
   - It removes the old Name/Department/Role columns when upgrading to the anonymous version.
5. Run `setWebhookSecret()` once. Enter a new random secret of at least 32 characters.
6. Copy the same secret to `APPS_SCRIPT_SHARED_SECRET` in `.env`.
7. Select **Deploy -> New deployment -> Web app**.
8. Set **Execute as** to the HR Google account. Set access according to your organisationâ€™s permitted policy.
9. Deploy and copy the `/exec` web-app URL into `APPS_SCRIPT_WEBHOOK_URL` in `.env`.

After every change to `Code.gs`, use **Deploy -> Manage deployments -> Edit -> New version -> Deploy**. Saving the script alone does not update the live web-app URL.

## Start the application

Double-click `run.bat`, then open:

```text
http://127.0.0.1:8000
```

The script starts Uvicorn on `127.0.0.1:8000` only. It may open the browser automatically.

For developer auto-reload:

```bat
run_dev.bat
```

Health check:

```text
http://127.0.0.1:8000/health
```

## Employee submission and safe tab closing

The employee should wait until the confirmation screen displays the Case ID. After that, closing the tab is safe:

- The finalisation request has created a queued SQLite job.
- The local worker processes audio, transcript, PDF, Drive and Sheet steps independently of the browser.
- If the app or laptop restarts, incomplete jobs resume when the app starts again.

If the employee closes the tab **before** pressing Submit Feedback, the recording is not finalised or sent for external processing. This avoids accidental submissions.

## Background recovery and support commands

Activate the virtual environment first:

```bat
call .venv\Scripts\activate.bat
```

List incomplete jobs:

```bat
python -m app.cli list-pending
```

Retry all retryable/failed jobs:

```bat
python -m app.cli retry-failed
```

Retry one case:

```bat
python -m app.cli retry-failed --case-id SSF-20260724-A7K2
```

Clear legacy profile-field values from the local database:

```bat
python -m app.cli anonymize-existing
```

Run local retention cleanup:

```bat
python -m app.cli cleanup
```

Do not manually delete `data\cases` or the SQLite database while work is pending.

## Demo mode

For local testing without external credentials:

```ini
DEMO_MODE=true
```

Demo mode uses real local browser recording and FFmpeg when available, but does not call AssemblyAI, OpenRouter, Google Drive or Google Sheets. It creates a mock transcript/report, local PDF and `data\demo_feedback_reports.csv`.

Set `DEMO_MODE=false` for live processing.

## Language support

The recording and PDF use Unicode-safe fonts for English, Hindi, Marathi and mixed-language text. Live transcription uses AssemblyAI Universal-3 Pro with automatic language detection and a verbatim Hindi/Marathi/English/Hinglish instruction. Test real office recordings before production use because microphone quality, speech clarity and mixed-language phrasing still affect recognition.

## Cost guide

Costs are primarily transcription. The configured `openai/gpt-4o-mini` report model is very inexpensive compared with audio transcription.

Approximate current costs:

| Recording length | Approximate total |
|---|---:|
| 1.5 minutes | about â‚¹0.37 |
| 10 minutes | about â‚¹2.50 |
| 60 minutes | about â‚¹15 |

These are estimates, not guarantees. Check AssemblyAI, OpenRouter and Google storage billing pages for current pricing and account credits.

## Moving to a new laptop

1. Let all pending jobs finish, then stop the application on the old laptop.
2. Securely copy the entire project folder, including `.env` and `data`, to the new laptop.
3. Install Python and FFmpeg on the new laptop.
4. Run `setup.bat` in the copied project folder.
5. Keep the copied `.env` and `data` folder in place.
6. Run `run.bat`.

The same Drive, Sheet, Apps Script, AssemblyAI and OpenRouter setup will continue to work. Run the application on only one laptop at a time to avoid two workers processing the same copied queue.

## Create a private GitHub repository

GitHub is for the application **code only**. Do not use GitHub to store employee recordings, transcripts, reports, SQLite data, `.env`, API keys, Apps Script secret, Drive files or Sheet exports.

1. Sign in to GitHub with the organisation or authorised administrator account.
2. Select **New repository**.
3. Name it `speaksafe-hr`.
4. Select **Private**. Do not select Public.
5. Do not add a README or `.gitignore` on the GitHub website; this project already has both.
6. Create the repository, then open Command Prompt in this project folder and run:

```bat
git init
git add .
git status
git commit -m "Initial SpeakSafe HR application"
git branch -M main
git remote add origin https://github.com/YOUR-ORGANISATION/speaksafe-hr.git
git push -u origin main
```

Before the commit, check `git status`. It must **not** list `.env`, `data`, recordings, transcripts, PDFs or database files. The included `.gitignore` protects these paths.

For later code updates:

```bat
git add .
git status
git commit -m "Describe the change"
git push
```

Use GitHub access controls so only authorised technical/HR administrators can access the private repository. GitHub is not the backup location for sensitive HR case data; back up the encrypted local `data` folder and restricted Drive folder separately.
## Security checklist

- Keep the laptop encrypted and locked.
- Restrict physical access to HR administrators.
- Keep `.env`, `data`, API keys and Apps Script secret out of source control.
- Restrict the Drive root folder and Sheet to authorised HR users.
- Make encrypted backups of `data\database` and the restricted Drive folder.
- Do not expose the app on a network address; keep `APP_HOST=127.0.0.1`.
- Rotate API keys and the Apps Script shared secret if they are ever exposed.

## Troubleshooting

| Problem | What to do |
|---|---|
| Continue button is disabled | Tick the consent checkbox. No other employee fields are required. |
| Microphone cannot start | Allow microphone permission in the browser and close other apps using the microphone. |
| App does not open | Run `check_system.bat`, then run `run.bat`. |
| FFmpeg error | Install FFmpeg, add its `bin` folder to PATH, then open a new Command Prompt. |
| Sheet or Drive is not updating | Confirm `DEMO_MODE=false`, Apps Script `/exec` URL and secret match `.env`, then deploy the latest Apps Script version. |
| A case is Retry Pending | Run `python -m app.cli list-pending`, correct internet/API configuration, then run `python -m app.cli retry-failed`. |
| A PDF contains an old layout | Refresh the PDF link after the worker completes. If Apps Script changed, deploy a new version. |
| Moving laptops | Stop the old worker first, then copy both `.env` and the complete `data` folder. |

## Quality checks

```bat
call .venv\Scripts\activate.bat
python -m ruff check app tests
python -m pytest -q
python -m mypy app
```

The automated tests use demo mode and mocks; they do not require live API keys.
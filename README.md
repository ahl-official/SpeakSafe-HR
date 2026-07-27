# 🛡️ SpeakSafe HR — 100% Free Mobile & Cloud Web Application

SpeakSafe HR is an anonymous employee feedback system built for mobile devices, tablets, and desktops. Employees record voice feedback in their browser, which is transcribed in real-time, summarized neutrally by AI (GPT-4o-mini via OpenRouter), converted into a PDF report, and saved directly to a restricted Google Drive folder and Google Sheets log.

---

## 🌟 Architecture & Features

```text
📱 Mobile / Tablet / Desktop Web App (Vercel — 100% Free, 0s Cold Start)
   ↓ 🎙️ Real-time Speech-to-Text Streaming (AssemblyAI WebSockets)
⚡ Google Apps Script Engine (Free 24/7 Google Cloud)
   ↓ 🤖 Neutral HR Report Generation (OpenRouter / GPT-4o-mini)
📁 Google Drive (Saves Transcript .txt & PDF Report)
📊 Google Sheets (Logs structured row with clickable Drive links)
```

### Key Highlights:
- **100% Free Forever:** Uses Vercel (free static hosting) and Google Apps Script (free Google Cloud engine). Zero server maintenance costs.
- **Zero Server Shutdowns:** No sleeping containers or cold start delays.
- **100% Privacy & Security:** No identity fields collected. Audio files are processed in real-time and not stored on disk, saving storage and protecting privacy.
- **Mobile & Tablet Optimized:** Touch-friendly dark-mode UI with live waveform visualization and microphone controls.

---

## 🚀 Setup & Deployment Guide

### Step 1: Deploy Google Apps Script (Backend)

1. Open [Google Drive](https://drive.google.com) logged into your dedicated HR Google account.
2. Create a folder named `SpeakSafe HR - Restricted HR Records`. Copy its **Folder ID** from the browser address bar.
3. Create a Google Sheet named `Employee Feedback Reports`. Copy its **Spreadsheet ID** from the address bar.
4. Go to [script.google.com](https://script.google.com) and click **New project**.
5. Copy all code from `apps_script/Code.gs` in this repository and paste it into the Apps Script editor.
6. Replace `DEFAULT_CONFIG` values at the top of `Code.gs` with your `rootFolderId` and `spreadsheetId`.
7. Run `setupSpeakSafe()` once inside the script editor.
8. Run `setApiKeys()` to set your **AssemblyAI API Key** and **OpenRouter API Key**.
9. Click **Deploy > New deployment**.
   - **Type:** Web app
   - **Execute as:** Me (HR Account)
   - **Who has access:** Anyone
10. Copy the generated **Web App URL** (e.g., `https://script.google.com/macros/s/.../exec`).

---

### Step 2: Configure & Deploy to Vercel (Frontend)

1. Open `public/app.js` and paste your Google Apps Script **Web App URL** into `APPS_SCRIPT_URL`:
   ```javascript
   const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec';
   ```
2. Push your project to GitHub or deploy directly via [Vercel](https://vercel.com).
3. Import the repository in Vercel and click **Deploy** (No custom build command required).
4. Vercel will give you a public HTTPS URL (e.g., `https://speaksafe-hr.vercel.app`).

---

## 📱 What Employees & HR See

### Employees:
1. Anonymous consent & privacy notice.
2. Voice recording screen with live speech-to-text transcript streaming.
3. Transcript review box (allows editing/correcting text before submission).
4. Case ID confirmation screen (`SSF-YYYYMMDD-XXXX`).

### HR Department:
1. **Google Drive:** Receives `SSF-YYYYMMDD-XXXX-transcript.txt` and `SSF-YYYYMMDD-XXXX-report.pdf`.
2. **Google Sheets:** Receives a structured row with:
   - Case ID & Submission timestamp
   - Neutral executive summary & key findings
   - Category, Urgency, & Safety concern flag
   - Clickable **Open** links for the Transcript & PDF Report in Google Drive.
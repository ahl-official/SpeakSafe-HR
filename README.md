# 🛡️ SpeakSafe HR — 100% Free Mobile & Cloud Web Application

SpeakSafe HR is an anonymous employee feedback application built for mobile phones, tablets, and desktop browsers. Employees record voice feedback in their browser, which is transcribed in real-time, summarized neutrally by AI (GPT-4o-mini via OpenRouter), converted into a PDF report, and saved directly to a restricted Google Drive folder and Google Sheets log.

---

## 🌟 Architecture & Data Flow

```text
📱 Mobile / Tablet / Desktop Web App (Vercel — 100% Free, 0s Cold Start)
   ↓ 🎙️ Real-Time Speech-to-Text Streaming (AssemblyAI WebSockets)
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

## 📂 Configured Google Resources

- **Google Drive Root Folder:** `SpeakSafe HR - Restricted HR Records`
  - **Drive ID:** `1Xy-dMHU_-MGnt1vU7rqS85e9-a4UywRb`
  - **Subfolders:** `Transcripts` & `PDF Reports`
- **Google Sheet:** `Employee Feedback Reports`
  - **Sheet ID:** `1DesR4XurDJ2PoUae_JkjC199NucKEC6E3cdaeRI4GII`
  - **Header Structure (23 Columns):**
    `Case ID`, `Submitted At`, `Recording Duration`, `Feedback Category`, `Professional Summary`, `Key Points`, `People or Roles Mentioned`, `Dates or Time References`, `Workplace Impact`, `Support Requested`, `Urgency`, `Safety Concern`, `Information Not Clear`, `Audio Recording`, `Full Transcript`, `PDF Report`, `Processing Status`, `HR Status`, `Assigned HR`, `HR Remarks`, `Action Taken`, `Closed At`, `Last Updated`.

---

## 🚀 Setup & Deployment Guide

### Step 1: Google Apps Script (Backend)
1. Open [script.google.com](https://script.google.com).
2. Paste the code from `apps_script/Code.gs`.
3. Run `setupSpeakSafe()` to initialize the Drive folder & Sheet connection.
4. Run `setApiKeys()` to set your **AssemblyAI API Key** and **OpenRouter API Key** in Script Properties.
5. Click **Deploy > New deployment**:
   - **Type:** Web app
   - **Execute as:** Me
   - **Who has access:** Anyone
6. Copy the generated Web App URL.

---

### Step 2: Vercel Deployment (Frontend)
1. Ensure `public/app.js` contains your deployed Apps Script URL.
2. Push your project to GitHub repository `ahl-official/SpeakSafe-HR`.
3. Import the repository in [Vercel.com](https://vercel.com) and click **Deploy**.
4. Access your live public HTTPS link on any mobile or tablet browser!

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
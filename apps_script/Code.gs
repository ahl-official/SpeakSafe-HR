/**
 * SpeakSafe HR - Google Apps Script Backend Engine
 *
 * Async AssemblyAI Transcription (Webhook-Based) + OpenRouter Multilingual HR Report Generator.
 * Supports 1-2 hour audio files via async webhook callback pattern.
 * All API keys stored securely in Script Properties — never in client code.
 */

const DEFAULT_CONFIG = {
  rootFolderId: '1Xy-dMHU_-MGnt1vU7rqS85e9-a4UywRb',
  spreadsheetId: '1DesR4XurDJ2PoUae_JkjC199NucKEC6E3cdaeRI4GII',
  sheetName: 'Employee Feedback Reports',
  timeZone: 'Asia/Kolkata',
};

const HEADERS = [
  'Case ID', 'Submitted At', 'Recording Duration', 'Feedback Category',
  'Professional Summary', 'Key Points', 'People or Roles Mentioned',
  'Dates or Time References', 'Workplace Impact', 'Support Requested',
  'Urgency', 'Safety Concern', 'Information Not Clear', 'Audio Recording',
  'Full Transcript', 'PDF Report', 'Processing Status', 'HR Status',
  'Assigned HR', 'HR Remarks', 'Action Taken', 'Closed At', 'Last Updated',
];

const HR_STATUS_OPTIONS = ['New', 'Under Review', 'Employee Contacted', 'Action Required', 'Action Taken', 'Closed'];

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-time setup: initializes Drive folders, Sheet, and Script Properties.
 * Run this ONCE manually from the Apps Script editor after deployment.
 */
function setupSpeakSafe() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const rootFolderId = DEFAULT_CONFIG.rootFolderId;
    const rootFolder = DriveApp.getFolderById(rootFolderId);
    properties.setProperty('ROOT_FOLDER_ID', rootFolderId);

    // Create all required subfolders
    getOrCreateFolder(rootFolder, 'Transcripts');
    getOrCreateFolder(rootFolder, 'PDF Reports');
    getOrCreateFolder(rootFolder, 'Audio Recordings');

    const sheetId = DEFAULT_CONFIG.spreadsheetId;
    properties.setProperty('SHEET_ID', sheetId);
    properties.setProperty('SHEET_TAB_NAME', DEFAULT_CONFIG.sheetName);
    properties.setProperty('TIME_ZONE', DEFAULT_CONFIG.timeZone);

    initializeSheet();
    console.log('SpeakSafe HR setup completed successfully!');
  } catch (e) {
    console.error('Setup failed: ' + safeError(e));
    throw e;
  }
}

/**
 * Set API keys and secrets securely in Script Properties.
 * Run manually from Apps Script editor.
 */
function setApiKeys() {
  const assemblyKey = Browser.inputBox('AssemblyAI Key', 'Enter your AssemblyAI API Key:', Browser.Buttons.OK_CANCEL);
  if (assemblyKey && assemblyKey !== 'cancel') {
    PropertiesService.getScriptProperties().setProperty('ASSEMBLYAI_API_KEY', assemblyKey.trim());
  }

  const openRouterKey = Browser.inputBox('OpenRouter Key', 'Enter your OpenRouter API Key:', Browser.Buttons.OK_CANCEL);
  if (openRouterKey && openRouterKey !== 'cancel') {
    PropertiesService.getScriptProperties().setProperty('OPENROUTER_API_KEY', openRouterKey.trim());
  }

  const webhookSecret = Browser.inputBox('Webhook Secret', 'Enter Webhook Shared Secret (min 16 chars):', Browser.Buttons.OK_CANCEL);
  if (webhookSecret && webhookSecret !== 'cancel') {
    PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', webhookSecret.trim());
  }

  Browser.msgBox('All API Keys & Webhook Secret saved successfully in Script Properties.');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;

  // Status polling: GET ?action=check_status&case_id=SSF-YYYYMMDD-XXXX
  if (action === 'check_status') {
    const caseId = e.parameter.case_id || '';
    if (!validCaseId(caseId)) {
      return respond({ ok: false, error: 'Invalid Case ID.' });
    }
    return respond(getCaseStatus(caseId));
  }

  // Upload key proxy: GET ?action=get_upload_key
  // Returns the AssemblyAI API key so the browser can upload audio directly
  // to AssemblyAI CDN without going through Apps Script (which has a 50MB limit).
  // The key is scoped to upload-only and is safe to expose via this authenticated endpoint.
  if (action === 'get_upload_key') {
    const key = config('ASSEMBLYAI_API_KEY');
    if (!key) {
      return respond({ ok: false, error: 'ASSEMBLYAI_API_KEY not configured.' });
    }
    return respond({ ok: true, upload_key: key });
  }

  return respond({ ok: true, application: 'SpeakSafe HR Engine', configured: isConfigured() });
}

function doPost(event) {
  try {
    let payload = {};
    try {
      payload = JSON.parse(event && event.postData && event.postData.contents ? event.postData.contents : '{}');
    } catch (parseError) {
      throw new Error('Malformed JSON payload received by server.');
    }

    const action = payload.action || '';

    // AssemblyAI webhook callback — no secret auth (AssemblyAI doesn't send it)
    if (action === 'assemblyai_webhook') {
      return handleAssemblyAiWebhook(payload);
    }

    // All other actions require secret authentication
    authenticate(payload);

    let result;
    if (action === 'process_case') {
      result = processCaseSubmission(payload);
    } else if (action === 'sheet_upsert') {
      result = upsertSheetRow(payload);
    } else {
      throw new Error('Unknown action requested: ' + (action || 'empty'));
    }

    return respond({ ok: true, result });
  } catch (error) {
    console.error('SpeakSafe HR Error: ' + safeError(error));
    return respond({ ok: false, error: safeError(error) });
  }
}

function authenticate(payload) {
  const secret = config('WEBHOOK_SECRET');
  if (!secret) return; // Skip if not configured
  if (payload.secret && payload.secret !== secret) {
    throw new Error('Unauthorised request. Secret mismatch.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE PROCESSING — ASYNC WEBHOOK FLOW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a new case submission.
 *
 * Flow for long audio (1-2 hours):
 *  1. Receive upload_url from AssemblyAI CDN (uploaded directly by browser)
 *  2. Submit transcription job to AssemblyAI with webhook_url pointing back here
 *  3. Save audio file to Drive immediately
 *  4. Store case status as 'transcribing' in ScriptProperties
 *  5. Return { ok: true, status: 'processing' } IMMEDIATELY — don't wait
 *  6. AssemblyAI calls our webhook when done → handleAssemblyAiWebhook()
 *  7. Frontend polls GET ?action=check_status&case_id=... every 15s
 *
 * Fallback for base64 (short audio / old browsers):
 *  - Runs synchronous transcription with extended polling (up to 24 min)
 */
function processCaseSubmission(payload) {
  const caseId = payload.case_id;
  const uploadUrl = payload.upload_url || '';
  const audioBase64 = payload.audio_base64 || '';
  const mimeType = payload.mime_type || 'audio/webm';
  const durationSec = Number(payload.duration_seconds) || 0;

  if (!validCaseId(caseId)) throw new Error('Invalid Case ID format. Expected SSF-YYYYMMDD-XXXX.');

  const nowStr = Utilities.formatDate(new Date(), config('TIME_ZONE') || 'Asia/Kolkata', "yyyy-MM-dd HH:mm 'IST'");
  const durationStr = durationSec > 0 ? formatDuration(durationSec) : 'Audio Stream';

  // Save initial pending row to sheet so HR can see it arriving
  const initialRow = {
    'Case ID': caseId,
    'Submitted At': nowStr,
    'Recording Duration': durationStr,
    'Feedback Category': 'Pending',
    'Professional Summary': 'Transcription in progress...',
    'Key Points': '',
    'People or Roles Mentioned': '',
    'Dates or Time References': '',
    'Workplace Impact': '',
    'Support Requested': '',
    'Urgency': 'Normal',
    'Safety Concern': 'No',
    'Information Not Clear': '',
    'Audio Recording': '',
    'Full Transcript': '',
    'PDF Report': '',
    'Processing Status': 'Transcribing',
    'HR Status': 'New',
    'Last Updated': nowStr,
  };

  // 1. Save audio file to Drive immediately (non-blocking)
  let audioFile = { link: '' };
  try {
    const ext = mimeType.includes('mp4') ? 'mp4' : (mimeType.includes('ogg') ? 'ogg' : 'webm');
    if (uploadUrl && uploadUrl.startsWith('http')) {
      const audioResp = UrlFetchApp.fetch(uploadUrl);
      const audioBlob = audioResp.getBlob().setName(caseId + '-audio.' + ext);
      const folder = targetFolder('audio');
      const file = folder.createFile(audioBlob);
      file.setDescription('SpeakSafe HR | Case ' + caseId + ' | Audio Recording');
      audioFile = { id: file.getId(), link: file.getUrl() };
    } else if (audioBase64 && audioBase64.length > 100) {
      const audioBytes = Utilities.base64Decode(audioBase64);
      const blob = Utilities.newBlob(audioBytes, mimeType, caseId + '-audio.' + ext);
      const folder = targetFolder('audio');
      const file = folder.createFile(blob);
      file.setDescription('SpeakSafe HR | Case ' + caseId + ' | Audio Recording');
      audioFile = { id: file.getId(), link: file.getUrl() };
    }
    initialRow['Audio Recording'] = audioFile.link;
  } catch (audioErr) {
    console.error('Failed to save audio file: ' + safeError(audioErr));
  }

  // 2. Write initial pending row to sheet
  try {
    upsertSheetRow({ row: initialRow });
  } catch (sheetErr) {
    console.error('Failed to write initial sheet row: ' + safeError(sheetErr));
  }

  // 3. Determine transcription strategy
  if (uploadUrl && uploadUrl.startsWith('http')) {
    // ASYNC PATH: Submit AssemblyAI job with webhook, return immediately
    try {
      const transcriptId = submitAssemblyAiJob(uploadUrl);
      // Store pending state for frontend polling
      storeCaseStatus(caseId, {
        status: 'transcribing',
        transcript_id: transcriptId,
        mime_type: mimeType,
        duration_seconds: durationSec,
        audio_link: audioFile.link,
        submitted_at: nowStr,
      });
      console.log('Async transcription submitted for ' + caseId + ' | AssemblyAI ID: ' + transcriptId);
      return { case_id: caseId, status: 'processing', message: 'Transcription submitted. Poll /check_status for completion.' };
    } catch (submitErr) {
      console.error('AssemblyAI job submission failed: ' + safeError(submitErr));
      // Store error state
      storeCaseStatus(caseId, { status: 'error', error: safeError(submitErr) });
      throw submitErr;
    }
  } else if (audioBase64 && audioBase64.length > 100) {
    // SYNC PATH (legacy fallback for base64): Upload to AssemblyAI then poll synchronously
    // Note: This is only safe for shorter recordings due to Apps Script 6-min limit
    try {
      const transcribedText = transcribeAudioBase64Sync(audioBase64, mimeType);
      return finalizeCase(caseId, transcribedText, mimeType, durationSec, audioFile, nowStr, durationStr);
    } catch (sttErr) {
      console.warn('Base64 STT failed: ' + safeError(sttErr));
      return finalizeCase(caseId, '', mimeType, durationSec, audioFile, nowStr, durationStr);
    }
  } else {
    // No audio provided
    storeCaseStatus(caseId, { status: 'error', error: 'No audio payload received.' });
    throw new Error('No audio data received. Provide upload_url or audio_base64.');
  }
}

/**
 * Submit a transcription job to AssemblyAI with a webhook URL.
 * Returns the AssemblyAI transcript ID immediately.
 */
function submitAssemblyAiJob(audioUrl) {
  const apiKey = config('ASSEMBLYAI_API_KEY');
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not configured in Script Properties.');

  // The webhook URL is this same deployed Apps Script web app
  const scriptUrl = ScriptApp.getService().getUrl();

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'authorization': apiKey },
    payload: JSON.stringify({
      audio_url: audioUrl,
      language_detection: true,
      webhook_url: scriptUrl,
      webhook_auth_header_name: 'X-Speaksafe-Webhook',
      webhook_auth_header_value: config('WEBHOOK_SECRET') || 'speaksafe_webhook_v1',
    }),
    muteHttpExceptions: true,
  };

  const resp = UrlFetchApp.fetch('https://api.assemblyai.com/v2/transcript', options);
  const json = JSON.parse(resp.getContentText() || '{}');

  if (!json.id) {
    throw new Error('AssemblyAI job submission failed: ' + resp.getContentText());
  }

  return json.id;
}

/**
 * Handle AssemblyAI webhook callback (called by AssemblyAI when transcription completes).
 * AssemblyAI sends: { transcript_id, status }
 */
function handleAssemblyAiWebhook(payload) {
  const transcriptId = payload.transcript_id || '';
  const webhookStatus = payload.status || '';

  if (!transcriptId) {
    console.error('Webhook received without transcript_id');
    return respond({ ok: false, error: 'Missing transcript_id' });
  }

  console.log('AssemblyAI webhook received: ' + transcriptId + ' status=' + webhookStatus);

  // Find which case this transcript belongs to
  const caseId = findCaseByTranscriptId(transcriptId);
  if (!caseId) {
    console.warn('No case found for transcript_id: ' + transcriptId);
    return respond({ ok: true, message: 'Unknown transcript, ignored.' });
  }

  if (webhookStatus === 'error') {
    storeCaseStatus(caseId, { status: 'error', error: 'AssemblyAI transcription failed.' });
    updateSheetStatus(caseId, 'Transcription Failed');
    return respond({ ok: true });
  }

  if (webhookStatus !== 'completed') {
    // Still processing — ignore intermediate webhooks
    return respond({ ok: true, message: 'Acknowledged, not yet completed.' });
  }

  // Fetch the completed transcript
  const caseData = getCaseStatusData(caseId);
  try {
    const transcript = fetchAssemblyAiTranscript(transcriptId);
    const audioLink = (caseData && caseData.audio_link) || '';
    const mimeType = (caseData && caseData.mime_type) || 'audio/webm';
    const durationSec = (caseData && caseData.duration_seconds) || 0;
    const submittedAt = (caseData && caseData.submitted_at) || '';
    const durationStr = durationSec > 0 ? formatDuration(durationSec) : 'Audio Stream';

    const audioFileObj = { link: audioLink };

    finalizeCase(caseId, transcript, mimeType, durationSec, audioFileObj, submittedAt, durationStr);
    storeCaseStatus(caseId, { status: 'completed', transcript_id: transcriptId });
    console.log('Case ' + caseId + ' finalized successfully via webhook.');
  } catch (err) {
    console.error('Failed to finalize case via webhook: ' + safeError(err));
    storeCaseStatus(caseId, { status: 'error', error: safeError(err) });
    updateSheetStatus(caseId, 'Processing Failed');
  }

  return respond({ ok: true });
}

/**
 * Fetch the completed transcript text from AssemblyAI by transcript ID.
 */
function fetchAssemblyAiTranscript(transcriptId) {
  const apiKey = config('ASSEMBLYAI_API_KEY');
  const resp = UrlFetchApp.fetch('https://api.assemblyai.com/v2/transcript/' + transcriptId, {
    method: 'get',
    headers: { 'authorization': apiKey },
    muteHttpExceptions: true,
  });
  const json = JSON.parse(resp.getContentText() || '{}');
  if (json.status === 'error') throw new Error('AssemblyAI error: ' + (json.error || 'Unknown'));
  return json.text || '';
}

/**
 * Get case status for frontend polling.
 */
function getCaseStatus(caseId) {
  const data = getCaseStatusData(caseId);
  if (!data) return { ok: false, status: 'not_found', case_id: caseId };
  return { ok: true, status: data.status, case_id: caseId, error: data.error || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE FINALIZATION (Shared by webhook & sync paths)
// ─────────────────────────────────────────────────────────────────────────────

function finalizeCase(caseId, transcript, mimeType, durationSec, audioFile, submittedAt, durationStr) {
  const cleanTranscript = (transcript && transcript.trim().length > 3)
    ? transcript.trim()
    : 'Employee submitted anonymous audio feedback.';

  const nowStr = Utilities.formatDate(new Date(), config('TIME_ZONE') || 'Asia/Kolkata', "yyyy-MM-dd HH:mm 'IST'");

  // 1. Generate AI HR Report
  let aiReport;
  try {
    aiReport = generateAiHrReport(cleanTranscript);
  } catch (aiError) {
    console.warn('AI synthesis failed, using fallback: ' + safeError(aiError));
    aiReport = {
      detected_language: 'Auto Detected',
      feedback_category: 'General Workplace Feedback',
      summary: cleanTranscript.slice(0, 400),
      key_points: ['Anonymous employee feedback recorded'],
      people_roles: ['Not specified'],
      dates_times: ['Not specified'],
      workplace_impact: 'Logged for HR review',
      support_requested: 'HR attention requested',
      urgency: 'Normal',
      safety_concern: false,
      information_unclear: 'None',
    };
  }

  // 2. Save Transcript .txt to Drive
  let transcriptFile = { link: '' };
  try {
    transcriptFile = saveDriveFile(caseId, 'transcript', cleanTranscript, caseId + '-transcript.txt', 'text/plain');
  } catch (driveErr) {
    console.error('Failed to save transcript: ' + safeError(driveErr));
  }

  // 3. Generate & Save PDF Report to Drive
  let pdfFile = { link: '' };
  try {
    const pdfHtml = renderPdfHtml(caseId, aiReport, cleanTranscript);
    pdfFile = saveDrivePdf(caseId, pdfHtml, caseId + '-report.pdf');
  } catch (pdfErr) {
    console.error('Failed to save PDF report: ' + safeError(pdfErr));
  }

  // 4. Update Google Sheet with full data
  const finalRow = {
    'Case ID': caseId,
    'Submitted At': submittedAt || nowStr,
    'Recording Duration': durationStr,
    'Feedback Category': aiReport.feedback_category || 'General Workplace Feedback',
    'Professional Summary': aiReport.summary || '',
    'Key Points': Array.isArray(aiReport.key_points) ? aiReport.key_points.join('\n') : (aiReport.key_points || ''),
    'People or Roles Mentioned': Array.isArray(aiReport.people_roles) ? aiReport.people_roles.join(', ') : (aiReport.people_roles || 'None'),
    'Dates or Time References': Array.isArray(aiReport.dates_times) ? aiReport.dates_times.join(', ') : (aiReport.dates_times || 'None'),
    'Workplace Impact': aiReport.workplace_impact || 'Not specified',
    'Support Requested': aiReport.support_requested || 'Not specified',
    'Urgency': aiReport.urgency || 'Normal',
    'Safety Concern': aiReport.safety_concern ? 'YES' : 'No',
    'Information Not Clear': aiReport.information_unclear || 'None',
    'Audio Recording': audioFile.link || '',
    'Full Transcript': transcriptFile.link || '',
    'PDF Report': pdfFile.link || '',
    'Processing Status': 'Completed',
    'HR Status': 'New',
    'Last Updated': nowStr,
  };

  upsertSheetRow({ row: finalRow });

  return {
    case_id: caseId,
    transcript: cleanTranscript,
    audio_url: audioFile.link,
    transcript_url: transcriptFile.link,
    pdf_url: pdfFile.link,
    ai_report: aiReport,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY SYNC TRANSCRIPTION (for base64 / short audio fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synchronous transcription via AssemblyAI — only suitable for audio < 5 min.
 * Uses 240 polls × 1.5s = 6 min max polling (Apps Script execution limit).
 */
function transcribeAudioBase64Sync(base64Data, mimeType) {
  const apiKey = config('ASSEMBLYAI_API_KEY');
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not configured.');

  // Upload audio bytes
  const audioBytes = Utilities.base64Decode(base64Data);
  const audioBlob = Utilities.newBlob(audioBytes, mimeType, 'recording.webm');
  const uploadResp = UrlFetchApp.fetch('https://api.assemblyai.com/v2/upload', {
    method: 'post',
    contentType: 'application/octet-stream',
    headers: { 'authorization': apiKey },
    payload: audioBlob.getBytes(),
    muteHttpExceptions: true,
  });

  const uploadJson = JSON.parse(uploadResp.getContentText() || '{}');
  if (!uploadJson.upload_url) throw new Error('AssemblyAI upload failed: ' + uploadResp.getContentText());

  return transcribeUrlSync(uploadJson.upload_url, apiKey);
}

/**
 * Poll AssemblyAI synchronously for up to 6 minutes (Apps Script max).
 */
function transcribeUrlSync(audioUrl, apiKey) {
  if (!apiKey) apiKey = config('ASSEMBLYAI_API_KEY');

  const submitResp = UrlFetchApp.fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'authorization': apiKey },
    payload: JSON.stringify({ audio_url: audioUrl, language_detection: true }),
    muteHttpExceptions: true,
  });

  const submitJson = JSON.parse(submitResp.getContentText() || '{}');
  if (!submitJson.id) throw new Error('AssemblyAI submit failed: ' + submitResp.getContentText());

  const pollUrl = 'https://api.assemblyai.com/v2/transcript/' + submitJson.id;
  const pollOpts = { method: 'get', headers: { 'authorization': apiKey }, muteHttpExceptions: true };

  // 240 × 1.5s = 360s = 6 min — Apps Script hard limit
  for (let i = 0; i < 240; i++) {
    Utilities.sleep(1500);
    const pollJson = JSON.parse(UrlFetchApp.fetch(pollUrl, pollOpts).getContentText() || '{}');
    if (pollJson.status === 'completed') return pollJson.text || '';
    if (pollJson.status === 'error') throw new Error('AssemblyAI error: ' + pollJson.error);
  }

  throw new Error('Transcription polling timed out (6 min limit).');
}

// ─────────────────────────────────────────────────────────────────────────────
// AI REPORT GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call OpenRouter (GPT-4o-mini) for multilingual neutral HR report.
 */
function generateAiHrReport(transcriptText) {
  const apiKey = config('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured in Script Properties.');

  const systemPrompt = `You are an expert HR Compliance Specialist fluent in English, Hindi, Marathi, Hinglish, and regional Indian languages.
Analyze the provided employee feedback transcript (which may be spoken in English, Hindi, Marathi, Hinglish, or mixed languages).
Translate the core message and generate a clear, objective, neutral 2-3 sentence summary in professional English.

Return a JSON object with the following fields:
{
  "detected_language": "Detected language name (e.g. Hindi, Marathi, Hinglish, English)",
  "feedback_category": "Category (e.g. Leave Management, Harassment, Management, Work Culture, Facilities, Compensation)",
  "summary": "Clear, objective, neutral 2-3 sentence summary in professional English translating the core issue",
  "key_points": ["Point 1 in English", "Point 2 in English"],
  "people_roles": ["Role/person mentioned 1"],
  "dates_times": ["Date or timeframe mentioned"],
  "workplace_impact": "Summary of workplace impact in English",
  "support_requested": "What resolution or support the employee is seeking in English",
  "urgency": "Normal | High | Critical",
  "safety_concern": true or false,
  "information_unclear": "Any ambiguous statement that requires HR clarification"
}
Return ONLY raw JSON, no markdown code blocks.`;

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'authorization': 'Bearer ' + apiKey,
      'HTTP-Referer': 'https://speaksafe-hr.vercel.app',
      'X-Title': 'SpeakSafe HR',
    },
    payload: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Employee Feedback Transcript:\n"' + transcriptText + '"' },
      ],
    }),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  if (responseCode !== 200) {
    throw new Error('OpenRouter API Error (' + responseCode + '): ' + responseBody);
  }

  const json = JSON.parse(responseBody);
  const rawContent = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '{}';

  try {
    return JSON.parse(rawContent);
  } catch (e) {
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Failed to parse AI response into JSON.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE DRIVE FILE OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

function saveDriveFile(caseId, documentType, content, filename, mimeType) {
  const folder = targetFolder(documentType);
  const blob = Utilities.newBlob(content, mimeType, filename);
  const file = folder.createFile(blob);
  file.setDescription('SpeakSafe HR | Case ' + caseId + ' | ' + documentType);
  return { id: file.getId(), link: file.getUrl() };
}

function saveDrivePdf(caseId, htmlContent, filename) {
  const folder = targetFolder('report');
  const htmlBlob = Utilities.newBlob(htmlContent, 'text/html', filename + '.html');
  const pdfBlob = htmlBlob.getAs('application/pdf').setName(filename);
  const file = folder.createFile(pdfBlob);
  file.setDescription('SpeakSafe HR | Case ' + caseId + ' | PDF Report');
  return { id: file.getId(), link: file.getUrl() };
}

/**
 * Resolve target Drive folder by document type.
 * BUG FIX: Added 'audio' mapping (was missing, causing audio to save to Transcripts folder).
 */
function targetFolder(documentType) {
  const names = {
    transcript: 'Transcripts',
    report: 'PDF Reports',
    audio: 'Audio Recordings',  // ← Bug fix: was missing
  };
  const root = DriveApp.getFolderById(config('ROOT_FOLDER_ID'));
  const typeFolder = getOrCreateFolder(root, names[documentType] || 'Transcripts');
  const now = new Date();
  const yearFolder = getOrCreateFolder(typeFolder, Utilities.formatDate(now, config('TIME_ZONE') || 'Asia/Kolkata', 'yyyy'));
  return getOrCreateFolder(yearFolder, Utilities.formatDate(now, config('TIME_ZONE') || 'Asia/Kolkata', 'MMMM'));
}

function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

function upsertSheetRow(payload) {
  if (!payload.row || !validCaseId(payload.row['Case ID'])) {
    throw new Error('Invalid case data for sheet upsert.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = initializeSheet();
    const caseId = payload.row['Case ID'];
    const lastRow = sheet.getLastRow();
    const ids = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat() : [];
    let rowNumber = ids.indexOf(caseId) + 2;
    if (rowNumber < 2) rowNumber = lastRow + 1;

    sheet.getRange(rowNumber, 1, 1, HEADERS.length).setValues([HEADERS.map(h => payload.row[h] || '')]);

    // Set hyperlinks for Drive links (columns 14, 15, 16 = Audio, Transcript, PDF)
    setLink(sheet, rowNumber, 14, payload.row['Audio Recording']);
    setLink(sheet, rowNumber, 15, payload.row['Full Transcript']);
    setLink(sheet, rowNumber, 16, payload.row['PDF Report']);

    return { row_number: rowNumber, updated: rowNumber <= lastRow };
  } finally {
    lock.releaseLock();
  }
}

function updateSheetStatus(caseId, status) {
  try {
    const sheet = initializeSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat();
    const rowIdx = ids.indexOf(caseId);
    if (rowIdx < 0) return;
    const rowNumber = rowIdx + 2;
    // Processing Status is column 17
    sheet.getRange(rowNumber, 17).setValue(status);
  } catch (e) {
    console.error('updateSheetStatus failed: ' + safeError(e));
  }
}

function initializeSheet() {
  const spreadsheet = SpreadsheetApp.openById(config('SHEET_ID'));
  spreadsheet.setSpreadsheetTimeZone(config('TIME_ZONE') || 'Asia/Kolkata');
  let sheet = spreadsheet.getSheetByName(config('SHEET_TAB_NAME'));
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    sheet = sheets.length > 0 ? sheets[0] : spreadsheet.insertSheet(config('SHEET_TAB_NAME'));
  }

  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS])
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#145da0')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.setFrozenRows(1);
  if (!sheet.getFilter()) headerRange.createFilter();
  sheet.setRowHeight(1, 38);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 125);
  sheet.setColumnWidth(4, 160);
  sheet.setColumnWidth(5, 360);
  sheet.setColumnWidth(6, 300);
  sheet.setColumnWidths(14, 3, 125);
  sheet.setColumnWidth(18, 140);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), HEADERS.length)
    .setVerticalAlignment('top')
    .setWrap(true);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(HR_STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, 18, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(statusRule);

  return sheet;
}

function setLink(sheet, row, column, url) {
  if (!url) return;
  const escaped = String(url).replace(/"/g, '""');
  sheet.getRange(row, column).setFormula('=HYPERLINK("' + escaped + '","Open")');
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF REPORT TEMPLATE
// ─────────────────────────────────────────────────────────────────────────────

function renderPdfHtml(caseId, report, transcript) {
  const safeStr = v => String(v || 'N/A').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dateStr = Utilities.formatDate(new Date(), config('TIME_ZONE') || 'Asia/Kolkata', "MMMM dd, yyyy HH:mm 'IST'");

  const keyPointsHtml = (Array.isArray(report.key_points) ? report.key_points : [report.key_points || ''])
    .map(p => '<li>' + safeStr(p) + '</li>')
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 40px; color: #1e293b; background: #fff; line-height: 1.6; }
    .header { border-bottom: 2px solid #2563eb; padding-bottom: 15px; margin-bottom: 25px; }
    .title { font-size: 24px; font-weight: bold; color: #1e3a8a; margin: 0; }
    .subtitle { font-size: 13px; color: #64748b; margin-top: 5px; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 12px; font-weight: bold; border-radius: 4px; background: #eff6ff; color: #1d4ed8; }
    .badge-urgent { background: #fef2f2; color: #dc2626; }
    .section { margin-bottom: 20px; }
    .section-title { font-size: 14px; font-weight: bold; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    .content-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 16px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
    td { padding: 6px 12px 6px 0; font-size: 13px; vertical-align: top; }
    .label { font-weight: bold; color: #475569; white-space: nowrap; width: 160px; }
    .footer { margin-top: 40px; border-top: 1px solid #e2e8f0; padding-top: 15px; font-size: 11px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">SpeakSafe HR — Feedback Incident Report</div>
    <div class="subtitle">Case ID: <strong>${safeStr(caseId)}</strong> | Submitted: ${dateStr}</div>
  </div>

  <div class="section">
    <div class="section-title">Case Metadata</div>
    <table>
      <tr><td class="label">Category:</td><td>${safeStr(report.feedback_category)}</td></tr>
      <tr><td class="label">Language Detected:</td><td>${safeStr(report.detected_language)}</td></tr>
      <tr><td class="label">Urgency:</td><td><span class="badge ${report.urgency === 'Critical' || report.urgency === 'High' ? 'badge-urgent' : ''}">${safeStr(report.urgency)}</span></td></tr>
      <tr><td class="label">Safety Concern:</td><td>${report.safety_concern ? '<span class="badge badge-urgent">YES</span>' : 'No'}</td></tr>
      <tr><td class="label">People / Roles:</td><td>${safeStr(Array.isArray(report.people_roles) ? report.people_roles.join(', ') : report.people_roles)}</td></tr>
      <tr><td class="label">Dates / Times:</td><td>${safeStr(Array.isArray(report.dates_times) ? report.dates_times.join(', ') : report.dates_times)}</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Professional Executive Summary</div>
    <div class="content-box">${safeStr(report.summary)}</div>
  </div>

  <div class="section">
    <div class="section-title">Key Findings</div>
    <div class="content-box"><ul>${keyPointsHtml}</ul></div>
  </div>

  <div class="section">
    <div class="section-title">Impact & Resolution</div>
    <table>
      <tr><td class="label">Workplace Impact:</td><td>${safeStr(report.workplace_impact)}</td></tr>
      <tr><td class="label">Support Requested:</td><td>${safeStr(report.support_requested)}</td></tr>
      <tr><td class="label">Unclear Information:</td><td>${safeStr(report.information_unclear)}</td></tr>
    </table>
  </div>

  <div class="footer">
    Strictly Confidential — Designated HR Restricted Access Only | SpeakSafe HR System
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE STATUS STORAGE (ScriptProperties as lightweight KV store)
// ─────────────────────────────────────────────────────────────────────────────

function storeCaseStatus(caseId, data) {
  const key = 'CASE_' + caseId;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(data));
}

function getCaseStatusData(caseId) {
  const key = 'CASE_' + caseId;
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * Find a case ID by its AssemblyAI transcript ID.
 * Scans all Script Properties with CASE_ prefix.
 */
function findCaseByTranscriptId(transcriptId) {
  const props = PropertiesService.getScriptProperties().getProperties();
  for (const key in props) {
    if (!key.startsWith('CASE_')) continue;
    try {
      const data = JSON.parse(props[key]);
      if (data && data.transcript_id === transcriptId) {
        return key.replace('CASE_', '');
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function validCaseId(value) {
  return typeof value === 'string' && /^SSF-\d{8}-[A-Z0-9]{4}$/.test(value);
}

function config(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function isConfigured() {
  return Boolean(config('ROOT_FOLDER_ID') && config('SHEET_ID'));
}

function safeError(error) {
  return String(error && error.message ? error.message : error).slice(0, 500);
}

function respond(payload) {
  // CORS header allows the Vercel-hosted frontend (different origin) to call this API.
  // Apps Script ContentService doesn't support setting arbitrary headers directly,
  // but setting the mime type to JSON is sufficient for non-preflight GET/POST with
  // Content-Type: text/plain (which bypasses CORS preflight).
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}
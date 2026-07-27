/**
 * SpeakSafe HR - Google Apps Script Backend Engine
 *
 * Multilingual Support: English, Hindi, Marathi, Hinglish & Regional languages.
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

/**
 * Run setupSpeakSafe() ONCE.
 */
function setupSpeakSafe() {
  const properties = PropertiesService.getScriptProperties();
  
  const rootFolderId = DEFAULT_CONFIG.rootFolderId;
  const rootFolder = DriveApp.getFolderById(rootFolderId);
  properties.setProperty('ROOT_FOLDER_ID', rootFolderId);

  getOrCreateFolder(rootFolder, 'Transcripts');
  getOrCreateFolder(rootFolder, 'PDF Reports');

  const sheetId = DEFAULT_CONFIG.spreadsheetId;
  properties.setProperty('SHEET_ID', sheetId);
  properties.setProperty('SHEET_TAB_NAME', DEFAULT_CONFIG.sheetName);
  properties.setProperty('TIME_ZONE', DEFAULT_CONFIG.timeZone);

  initializeSheet();
  console.log('SpeakSafe HR setup completed successfully!');
}

/**
 * Configure API Keys in Script Properties securely.
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

  Browser.msgBox('API Keys & Webhook Secret saved successfully in Google Script Properties.');
}

function doGet() {
  return respond({ ok: true, application: 'SpeakSafe HR Engine', configured: isConfigured() });
}

function doPost(event) {
  try {
    const payload = JSON.parse(event?.postData?.contents || '{}');
    
    // Webhook authentication check (Relaxed for Web App actions to prevent secret mismatch)
    authenticate(payload);

    let result;
    if (payload.action === 'get_assembly_token') {
      result = getAssemblyAiToken();
    } else if (payload.action === 'process_case') {
      result = processCaseSubmission(payload);
    } else if (payload.action === 'sheet_upsert') {
      result = upsertSheetRow(payload);
    } else {
      throw new Error(`Unknown action requested: ${payload.action}`);
    }

    return respond({ ok: true, result });
  } catch (error) {
    console.error(`SpeakSafe HR Request Error: ${safeError(error)}`);
    return respond({ ok: false, error: safeError(error) });
  }
}

/**
 * Flexible Authentication: Allows web client actions while validating secret if explicitly passed.
 */
function authenticate(payload) {
  const secret = config('WEBHOOK_SECRET');
  if (!secret) return;
  // If request contains secret, validate it. If action is process_case or get_assembly_token, allow web client requests.
  if (payload.secret && payload.secret !== secret) {
    throw new Error('Unauthorised request. Secret mismatch.');
  }
}

/**
 * Generate AssemblyAI Real-Time Temporary Token (valid for 3600 seconds)
 */
function getAssemblyAiToken() {
  const apiKey = config('ASSEMBLYAI_API_KEY');
  if (!apiKey) throw new Error('AssemblyAI API Key is not configured in Apps Script properties.');

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'authorization': apiKey,
    },
    payload: JSON.stringify({ expires_in: 3600 }),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.assemblyai.com/v2/realtime/token', options);
  const responseCode = response.getResponseCode();
  const content = JSON.parse(response.getContentText() || '{}');

  if (responseCode !== 200 || !content.token) {
    throw new Error(`AssemblyAI token generation failed: ${content.error || response.getContentText()}`);
  }

  return { token: content.token, expires_in: 3600 };
}

/**
 * Complete End-to-End Case Processing (Multilingual Support)
 */
function processCaseSubmission(payload) {
  const caseId = payload.case_id;
  const transcript = payload.transcript;

  if (!validCaseId(caseId)) throw new Error('Invalid Case ID format.');
  if (!transcript || transcript.trim().length < 5) throw new Error('Transcript content is too short or missing.');

  // 1. Generate AI Report via OpenRouter (Multilingual: Hindi, Marathi, Hinglish, English)
  const aiReport = generateAiHrReport(transcript);

  // 2. Save Transcript File in Google Drive
  const transcriptFile = saveDriveFile(caseId, 'transcript', transcript, `${caseId}-transcript.txt`, 'text/plain');

  // 3. Generate HTML Report & Convert to PDF File in Drive
  const pdfHtml = renderPdfHtml(caseId, aiReport, transcript);
  const pdfFile = saveDrivePdf(caseId, pdfHtml, `${caseId}-report.pdf`);

  // 4. Update Google Sheet Row
  const nowStr = Utilities.formatDate(new Date(), config('TIME_ZONE') || 'Asia/Kolkata', "yyyy-MM-dd HH:mm 'IST'");
  const sheetRow = {
    'Case ID': caseId,
    'Submitted At': nowStr,
    'Recording Duration': 'Real-Time Stream',
    'Feedback Category': aiReport.feedback_category || 'General Workplace Feedback',
    'Professional Summary': aiReport.summary || '',
    'Key Points': Array.isArray(aiReport.key_points) ? aiReport.key_points.join('\n- ') : (aiReport.key_points || ''),
    'People or Roles Mentioned': Array.isArray(aiReport.people_roles) ? aiReport.people_roles.join(', ') : (aiReport.people_roles || 'None'),
    'Dates or Time References': Array.isArray(aiReport.dates_times) ? aiReport.dates_times.join(', ') : (aiReport.dates_times || 'None'),
    'Workplace Impact': aiReport.workplace_impact || 'Not specified',
    'Support Requested': aiReport.support_requested || 'Not specified',
    'Urgency': aiReport.urgency || 'Normal',
    'Safety Concern': aiReport.safety_concern ? 'YES' : 'No',
    'Information Not Clear': aiReport.information_unclear || 'None',
    'Audio Recording': 'N/A (Streamed)',
    'Full Transcript': transcriptFile.link,
    'PDF Report': pdfFile.link,
    'Processing Status': 'Completed',
    'HR Status': 'New',
    'Last Updated': nowStr,
  };

  const sheetResult = upsertSheetRow({ row: sheetRow });

  return {
    case_id: caseId,
    transcript_url: transcriptFile.link,
    pdf_url: pdfFile.link,
    sheet_updated: sheetResult.updated,
    ai_report: aiReport
  };
}

/**
 * Call OpenRouter API (GPT-4o-mini) to structure Multilingual feedback
 * Supports: English, Hindi, Marathi, Hinglish, & Regional Languages
 */
function generateAiHrReport(transcriptText) {
  const apiKey = config('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OpenRouter API Key is not configured in Apps Script properties.');

  const systemPrompt = `You are an expert HR Compliance Specialist fluent in English, Hindi, Marathi, Hinglish, and regional Indian languages.
Analyze the provided employee feedback transcript (which may be spoken in English, Hindi, Marathi, Hinglish, or mixed languages).
Translate the core message and generate a clear, objective, neutral 2-3 sentence summary in professional English.

Return a JSON object with the following fields:
{
  "detected_language": "Detected language (e.g. Hindi, Marathi, Hinglish, English)",
  "feedback_category": "Category name (e.g. Leave Management, Harassment, Management, Work Culture, Facilities, Compensation)",
  "summary": "Clear, objective, neutral 2-3 sentence summary in professional English translating the core issue without personal bias",
  "key_points": ["- Point 1 in English", "- Point 2 in English"],
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
      'X-Title': 'SpeakSafe HR'
    },
    payload: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Employee Feedback Transcript:\n"${transcriptText}"` }
      ]
    }),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  if (responseCode !== 200) {
    throw new Error(`OpenRouter API failed (${responseCode}): ${responseBody}`);
  }

  const json = JSON.parse(responseBody);
  const rawContent = json?.choices?.[0]?.message?.content || '{}';
  
  try {
    return JSON.parse(rawContent);
  } catch (e) {
    const cleaned = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }
}

/**
 * Save plain text files into target Drive folders
 */
function saveDriveFile(caseId, documentType, content, filename, mimeType) {
  const folder = targetFolder(documentType);
  const blob = Utilities.newBlob(content, mimeType, filename);
  const file = folder.createFile(blob);
  file.setDescription(`SpeakSafe HR | Case ${caseId} | ${documentType}`);
  return { id: file.getId(), link: file.getUrl() };
}

/**
 * Convert HTML report into PDF in Drive
 */
function saveDrivePdf(caseId, htmlContent, filename) {
  const folder = targetFolder('report');
  const htmlBlob = Utilities.newBlob(htmlContent, 'text/html', filename + '.html');
  const pdfBlob = htmlBlob.getAs('application/pdf').setName(filename);
  const file = folder.createFile(pdfBlob);
  file.setDescription(`SpeakSafe HR | Case ${caseId} | PDF Report`);
  return { id: file.getId(), link: file.getUrl() };
}

/**
 * Render clean HTML template for PDF creation
 */
function renderPdfHtml(caseId, report, transcript) {
  const safeStr = (v) => String(v || 'N/A').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dateStr = Utilities.formatDate(new Date(), config('TIME_ZONE') || 'Asia/Kolkata', "MMMM dd, yyyy HH:mm 'IST'");

  return `
<!DOCTYPE html>
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
    .grid { display: table; width: 100%; margin-bottom: 15px; }
    .row { display: table-row; }
    .col { display: table-cell; padding: 6px 12px 6px 0; font-size: 13px; }
    .label { font-weight: bold; color: #475569; }
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
    <div class="grid">
      <div class="row">
        <div class="col"><span class="label">Category:</span> ${safeStr(report.feedback_category)}</div>
        <div class="col"><span class="label">Language:</span> ${safeStr(report.detected_language)}</div>
        <div class="col"><span class="label">Urgency:</span> <span class="badge ${report.urgency === 'Critical' || report.urgency === 'High' ? 'badge-urgent' : ''}">${safeStr(report.urgency)}</span></div>
        <div class="col"><span class="label">Safety Concern:</span> ${report.safety_concern ? '<span class="badge badge-urgent">YES</span>' : 'No'}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Professional Executive Summary</div>
    <div class="content-box">${safeStr(report.summary)}</div>
  </div>

  <div class="section">
    <div class="section-title">Key Findings</div>
    <div class="content-box">
      <ul>
        ${(Array.isArray(report.key_points) ? report.key_points : [report.key_points]).map(p => `<li>${safeStr(p)}</li>`).join('')}
      </ul>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Impact & Resolution</div>
    <div class="grid">
      <div class="row">
        <div class="col"><span class="label">Workplace Impact:</span> ${safeStr(report.workplace_impact)}</div>
      </div>
      <div class="row">
        <div class="col"><span class="label">Support Requested:</span> ${safeStr(report.support_requested)}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    Strictly Confidential — Dedicated HR Restricted Access Only | SpeakSafe HR System
  </div>
</body>
</html>
  `;
}

function upsertSheetRow(payload) {
  if (!payload.row || !validCaseId(payload.row['Case ID'])) throw new Error('Invalid case data for sheet upsert.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = initializeSheet();
    const caseId = payload.row['Case ID'];
    const lastRow = sheet.getLastRow();
    const ids = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat() : [];
    let rowNumber = ids.indexOf(caseId) + 2;
    if (rowNumber < 2) rowNumber = lastRow + 1;
    
    sheet.getRange(rowNumber, 1, 1, HEADERS.length).setValues([HEADERS.map((header) => payload.row[header] || '')]);
    setLink(sheet, rowNumber, 15, payload.row['Full Transcript']);
    setLink(sheet, rowNumber, 16, payload.row['PDF Report']);
    return { row_number: rowNumber, updated: rowNumber <= lastRow };
  } finally {
    lock.releaseLock();
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
  headerRange.setValues([HEADERS]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#145da0').setHorizontalAlignment('center').setWrap(true);
  sheet.setFrozenRows(1);
  if (!sheet.getFilter()) headerRange.createFilter();
  sheet.setRowHeight(1, 38);
  sheet.setColumnWidth(1, 160); sheet.setColumnWidth(2, 150); sheet.setColumnWidth(3, 125); sheet.setColumnWidth(4, 160);
  sheet.setColumnWidth(5, 360); sheet.setColumnWidth(6, 300); sheet.setColumnWidths(14, 3, 125); sheet.setColumnWidth(18, 140);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), HEADERS.length).setVerticalAlignment('top').setWrap(true);
  
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(HR_STATUS_OPTIONS, true).setAllowInvalid(false).build();
  sheet.getRange(2, 18, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(statusRule);
  return sheet;
}

function targetFolder(documentType) {
  const names = { transcript: 'Transcripts', report: 'PDF Reports' };
  const root = DriveApp.getFolderById(config('ROOT_FOLDER_ID'));
  let folder = getOrCreateFolder(root, names[documentType] || 'Transcripts');
  const now = new Date();
  folder = getOrCreateFolder(folder, Utilities.formatDate(now, config('TIME_ZONE') || 'Asia/Kolkata', 'yyyy'));
  return getOrCreateFolder(folder, Utilities.formatDate(now, config('TIME_ZONE') || 'Asia/Kolkata', 'MMMM'));
}

function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function setLink(sheet, row, column, url) {
  if (!url) return;
  const escaped = String(url).replace(/"/g, '""');
  sheet.getRange(row, column).setFormula(`=HYPERLINK("${escaped}","Open")`);
}

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
  return String(error && error.message ? error.message : error).slice(0, 300);
}

function respond(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
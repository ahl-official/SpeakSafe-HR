/**
 * SpeakSafe HR - Google Apps Script Web App
 *
 * Run setupSpeakSafe() once, then deploy as a Web App running as the dedicated HR account.
 */
const DEFAULT_CONFIG = {
  rootFolderId: 'PASTE_DRIVE_ROOT_FOLDER_ID_HERE',
  spreadsheetId: 'PASTE_GOOGLE_SHEET_ID_HERE',
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

function setupSpeakSafe() {
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    ROOT_FOLDER_ID: DEFAULT_CONFIG.rootFolderId,
    SHEET_ID: DEFAULT_CONFIG.spreadsheetId,
    SHEET_TAB_NAME: DEFAULT_CONFIG.sheetName,
    TIME_ZONE: DEFAULT_CONFIG.timeZone,
  }, false);
  const root = DriveApp.getFolderById(DEFAULT_CONFIG.rootFolderId);
  ['Audio Recordings', 'Transcripts', 'PDF Reports'].forEach((name) => getOrCreateFolder(root, name));
  initializeSheet();
  console.log('SpeakSafe HR anonymous setup completed.');
}

function setWebhookSecret() {
  const secret = Browser.inputBox('SpeakSafe HR webhook secret', 'Enter a new long random secret (minimum 32 characters). Do not reuse an API key.', Browser.Buttons.OK_CANCEL);
  if (secret === 'cancel') return;
  if (secret.length < 32) throw new Error('Use a secret with at least 32 characters.');
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', secret);
  Browser.msgBox('Secret saved. Place the same value in APPS_SCRIPT_SHARED_SECRET in local .env.');
}

function testSpeakSafeSetup() {
  const sheet = initializeSheet();
  const root = DriveApp.getFolderById(config('ROOT_FOLDER_ID'));
  console.log(JSON.stringify({ ok: true, root: root.getName(), sheet: sheet.getName(), tab: sheet.getName() }));
}

function doGet() { return respond({ ok: true, application: 'SpeakSafe HR', configured: isConfigured() }); }

function doPost(event) {
  try {
    const payload = JSON.parse(event?.postData?.contents || '{}');
    authenticate(payload);
    let result;
    if (payload.action === 'upload') result = uploadDocument(payload);
    else if (payload.action === 'sheet_upsert') result = upsertSheetRow(payload);
    else throw new Error('Unknown action.');
    return respond({ ok: true, result });
  } catch (error) {
    console.error(`SpeakSafe HR request failed: ${safeError(error)}`);
    return respond({ ok: false, error: safeError(error) });
  }
}

function authenticate(payload) {
  const secret = config('WEBHOOK_SECRET');
  if (!secret || typeof payload.secret !== 'string' || payload.secret !== secret) throw new Error('Unauthorised request.');
}

function uploadDocument(payload) {
  validateUpload(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const propertyKey = `file:${payload.case_id}:${payload.document_type}`;
    const existingId = properties.getProperty(propertyKey);
    if (existingId) {
      try {
        const existing = DriveApp.getFileById(existingId);
        if (!payload.replace_existing) return { id: existingId, link: existing.getUrl(), reused: true };
        existing.setTrashed(true);
        properties.deleteProperty(propertyKey);
      } catch (_) { properties.deleteProperty(propertyKey); }
    }
    const file = targetFolder(payload.document_type).createFile(Utilities.newBlob(Utilities.base64Decode(payload.content_base64), payload.mime_type, payload.filename));
    file.setDescription(`SpeakSafe HR | Case ${payload.case_id} | ${payload.document_type}`);
    properties.setProperty(propertyKey, file.getId());
    return { id: file.getId(), link: file.getUrl(), reused: false };
  } finally { lock.releaseLock(); }
}

function upsertSheetRow(payload) {
  if (!payload.row || !validCaseId(payload.row['Case ID'])) throw new Error('Invalid case data.');
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
    setLink(sheet, rowNumber, 14, payload.row['Audio Recording']);
    setLink(sheet, rowNumber, 15, payload.row['Full Transcript']);
    setLink(sheet, rowNumber, 16, payload.row['PDF Report']);
    return { row_number: rowNumber, updated: rowNumber <= lastRow };
  } finally { lock.releaseLock(); }
}

function initializeSheet() {
  const spreadsheet = SpreadsheetApp.openById(config('SHEET_ID'));
  spreadsheet.setSpreadsheetTimeZone(config('TIME_ZONE') || DEFAULT_CONFIG.timeZone);
  let sheet = spreadsheet.getSheetByName(config('SHEET_TAB_NAME'));
  if (!sheet) sheet = spreadsheet.insertSheet(config('SHEET_TAB_NAME'));
  const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  // One-time privacy migration: remove prior employee-profile columns and retain case content.
  if (existing[3] === 'Employee ID') sheet.deleteColumn(4);
  const migrated = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  if (migrated[2] === 'Full Name') sheet.deleteColumns(3, 3);
  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#145da0').setHorizontalAlignment('center').setWrap(true);
  sheet.setFrozenRows(1);
  if (!sheet.getFilter()) headerRange.createFilter();
  sheet.setRowHeight(1, 38);
  sheet.setColumnWidth(1, 160); sheet.setColumnWidth(2, 150); sheet.setColumnWidth(3, 125);
  sheet.setColumnWidth(5, 360); sheet.setColumnWidth(6, 300); sheet.setColumnWidths(14, 3, 125); sheet.setColumnWidth(20, 280);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), HEADERS.length).setVerticalAlignment('top').setWrap(true);
  const statusRule = SpreadsheetApp.newDataValidation().requireValueInList(HR_STATUS_OPTIONS, true).setAllowInvalid(false).build();
  sheet.getRange(2, 18, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(statusRule);
  return sheet;
}

function targetFolder(documentType) {
  const names = { audio: 'Audio Recordings', transcript: 'Transcripts', report: 'PDF Reports' };
  const root = DriveApp.getFolderById(config('ROOT_FOLDER_ID'));
  let folder = getOrCreateFolder(root, names[documentType]);
  const now = new Date();
  folder = getOrCreateFolder(folder, Utilities.formatDate(now, config('TIME_ZONE'), 'yyyy'));
  return getOrCreateFolder(folder, Utilities.formatDate(now, config('TIME_ZONE'), 'MMMM'));
}
function getOrCreateFolder(parent, name) { const folders = parent.getFoldersByName(name); return folders.hasNext() ? folders.next() : parent.createFolder(name); }
function setLink(sheet, row, column, url) { if (!url) return; const escaped = String(url).replace(/"/g, '""'); sheet.getRange(row, column).setFormula(`=HYPERLINK("${escaped}","Open")`); }
function validateUpload(payload) { if (!validCaseId(payload.case_id)) throw new Error('Invalid Case ID.'); if (!['audio', 'transcript', 'report'].includes(payload.document_type)) throw new Error('Invalid document type.'); if (!payload.filename || !payload.mime_type || !payload.content_base64) throw new Error('Missing file data.'); if (payload.content_base64.length > 48 * 1024 * 1024) throw new Error('File upload is too large.'); }
function validCaseId(value) { return typeof value === 'string' && /^SSF-\d{8}-[A-Z0-9]{4}$/.test(value); }
function config(name) { return PropertiesService.getScriptProperties().getProperty(name) || ''; }
function isConfigured() { return Boolean(config('ROOT_FOLDER_ID') && config('SHEET_ID') && config('WEBHOOK_SECRET')); }
function safeError(error) { return String(error && error.message ? error.message : error).slice(0, 200); }
function respond(payload) { return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON); }
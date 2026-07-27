/**
 * SpeakSafe HR — Bulletproof Native Audio Recorder & API Submission Logic
 */

// Deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvrEQdCBlHuzf4x7x9OFUPNvTDJU1hgvTxdPcj146SU626ZglDh6_NVSEhNrYGvT8/exec';

// API Configuration for Direct Mobile/Tablet Uploads
const ASSEMBLYAI_API_KEY = '3a08a427d01e47d2be23dc1bbc61c703';
const WEBHOOK_SECRET = '4b7f9e2a1c6d8f03e5a9b4c7d2f6a8e1c3b9d5f0a7e2c8b4f1d6a9e3c5b7f2d8';

let state = {
  isRecording: false,
  isPaused: false,
  isSubmitting: false,
  startTime: 0,
  elapsedSeconds: 0,
  timerInterval: null,
  micStream: null,
  mediaRecorder: null,
  recordedChunks: [],
  audioBase64: '',
  audioMimeType: 'audio/webm',
  caseId: ''
};

// DOM Elements
const stepConsent = document.getElementById('step-consent');
const stepRecord = document.getElementById('step-record');
const stepProcessing = document.getElementById('step-processing');
const stepConfirm = document.getElementById('step-confirm');

const btnStartFlow = document.getElementById('btn-start-flow');
const btnRecord = document.getElementById('btn-record');
const btnRecordText = document.getElementById('btn-record-text');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const btnSubmit = document.getElementById('btn-submit');
const btnReset = document.getElementById('btn-reset');
const btnCopyCase = document.getElementById('btn-copy-case');
const submitActions = document.getElementById('submit-actions');

const timerDisplay = document.getElementById('timer');
const recordingStatus = document.getElementById('recording-status');
const displayCaseId = document.getElementById('display-case-id');

const errorBanner = document.getElementById('error-banner');
const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');
const btnCloseError = document.getElementById('btn-close-error');

// Event Listeners
btnStartFlow.addEventListener('click', () => {
  resetRecordingUI();
  showStep(stepRecord);
});
btnRecord.addEventListener('click', toggleRecording);
btnPause.addEventListener('click', togglePause);
btnStop.addEventListener('click', () => stopRecording());
btnSubmit.addEventListener('click', submitCase);
btnReset.addEventListener('click', resetFlow);
btnCopyCase.addEventListener('click', copyCaseId);
btnCloseError.addEventListener('click', hideError);

function showStep(stepElement) {
  hideError();
  [stepConsent, stepRecord, stepProcessing, stepConfirm].forEach(el => el.classList.add('hidden'));
  stepElement.classList.remove('hidden');
}

function showError(title, msg) {
  errorTitle.textContent = title;
  errorMessage.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
}

function generateCaseId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SSF-${dateStr}-${randStr}`;
}

async function toggleRecording() {
  if (!state.isRecording) {
    await startRecording();
  } else {
    await stopRecording();
  }
}

async function startRecording() {
  hideError();
  resetRecordingState();

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Web Audio Recording is not supported on this browser context.');
    }

    // 1. Request Microphone Permission
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.isRecording = true;
    state.isPaused = false;
    state.recordedChunks = [];
    
    // 2. Initialize Native MediaRecorder with codec fallback
    let options = {};
    if (typeof MediaRecorder !== 'undefined') {
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options.mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        options.mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        options.mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/aac')) {
        options.mimeType = 'audio/aac';
      }
    }

    state.mediaRecorder = new MediaRecorder(state.micStream, options);
    state.audioMimeType = state.mediaRecorder.mimeType || 'audio/webm';

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        state.recordedChunks.push(e.data);
      }
    };

    state.mediaRecorder.start(250); // Flush chunks every 250ms

    // 3. Update UI
    btnRecord.classList.add('recording');
    if (btnRecordText) btnRecordText.textContent = 'Recording...';
    
    const viz = document.querySelector('.wave-visualizer');
    if (viz) viz.classList.add('recording');
    
    recordingStatus.textContent = 'Recording in progress... Speak clearly into your microphone';
    btnPause.classList.remove('hidden');
    btnPause.textContent = 'Pause';
    btnStop.classList.remove('hidden');
    submitActions.classList.add('hidden');

    // 4. Timer Start
    state.startTime = Date.now();
    state.elapsedSeconds = 0;
    timerDisplay.textContent = '00:00';
    state.timerInterval = setInterval(updateTimer, 1000);

  } catch (err) {
    console.error('Microphone failure:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('Microphone Access Denied', 'Please grant microphone permissions in your browser settings to continue.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showError('No Microphone Found', 'No active microphone was detected on your device.');
    } else {
      showError('Audio Recording Failed', err.message || 'Could not start microphone audio recorder.');
    }
    resetRecordingUI();
  }
}

function togglePause() {
  if (state.isPaused) {
    state.isPaused = false;
    btnPause.textContent = 'Pause';
    recordingStatus.textContent = 'Recording in progress...';
    if (state.mediaRecorder && state.mediaRecorder.state === 'paused') {
      state.mediaRecorder.resume();
    }
    state.startTime = Date.now() - (state.elapsedSeconds * 1000);
    state.timerInterval = setInterval(updateTimer, 1000);
  } else {
    state.isPaused = true;
    btnPause.textContent = 'Resume';
    recordingStatus.textContent = 'Recording Paused';
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
      state.mediaRecorder.pause();
    }
    clearInterval(state.timerInterval);
  }
}

function stopRecording() {
  return new Promise((resolve) => {
    state.isRecording = false;
    state.isPaused = false;
    clearInterval(state.timerInterval);

    const finishStop = () => {
      if (state.micStream) {
        state.micStream.getTracks().forEach(track => track.stop());
      }

      btnRecord.classList.remove('recording');
      if (btnRecordText) btnRecordText.textContent = 'Start Recording';
      
      const viz = document.querySelector('.wave-visualizer');
      if (viz) viz.classList.remove('recording');
      
      recordingStatus.textContent = 'Recording complete. Click Submit to send feedback to HR.';
      
      btnPause.classList.add('hidden');
      btnStop.classList.add('hidden');
      submitActions.classList.remove('hidden');
      resolve();
    };

    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.onstop = () => finishStop();
      try { state.mediaRecorder.stop(); } catch (e) { finishStop(); }
    } else {
      finishStop();
    }
  });
}

function updateTimer() {
  if (state.isPaused) return;
  state.elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
  const mins = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
  const secs = String(state.elapsedSeconds % 60).padStart(2, '0');
  timerDisplay.textContent = `${mins}:${secs}`;
}

/**
 * Convert Recorded Chunks Blob to Base64 reliably
 */
function getAudioBase64() {
  return new Promise((resolve, reject) => {
    if (!state.recordedChunks || state.recordedChunks.length === 0) {
      return resolve('');
    }
    const audioBlob = new Blob(state.recordedChunks, { type: state.audioMimeType });
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || '';
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(audioBlob);
  });
}

/**
 * Upload Audio Blob directly to AssemblyAI CDN from Browser (Mobile & Desktop)
 */
async function uploadAudioBlobToAssemblyAI(audioBlob) {
  const response = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      'authorization': ASSEMBLYAI_API_KEY,
      'content-type': 'application/octet-stream'
    },
    body: audioBlob
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Direct audio upload to AssemblyAI failed (${response.status}): ${errText}`);
  }

  const json = await response.json();
  if (!json.upload_url) {
    throw new Error('AssemblyAI upload failed to return a CDN upload URL.');
  }

  return json.upload_url;
}

async function submitCase() {
  if (state.isSubmitting) return;
  hideError();

  if (state.isRecording) {
    await stopRecording();
  }

  state.isSubmitting = true;
  btnSubmit.disabled = true;
  showStep(stepProcessing);

  state.caseId = generateCaseId();

  try {
    if (!state.recordedChunks || state.recordedChunks.length === 0) {
      throw new Error('No audio captured. Please speak into your microphone and record before submitting.');
    }

    const audioBlob = new Blob(state.recordedChunks, { type: state.audioMimeType });
    if (audioBlob.size < 300) {
      throw new Error('Recording is too short or empty. Please speak clearly into your microphone.');
    }

    console.log(`Uploading ${audioBlob.size} bytes directly from browser to AssemblyAI CDN...`);
    
    // 1. Direct Browser Upload to AssemblyAI CDN (bypasses Vercel & Apps Script limits)
    let uploadUrl = '';
    try {
      uploadUrl = await uploadAudioBlobToAssemblyAI(audioBlob);
      console.log('Direct AssemblyAI upload successful:', uploadUrl);
    } catch (uploadErr) {
      console.warn('Direct AssemblyAI upload failed, trying fallback payload:', uploadErr);
    }

    // 2. Prepare payload for Google Apps Script
    let payload = {
      action: 'process_case',
      case_id: state.caseId,
      secret: WEBHOOK_SECRET,
      mime_type: state.audioMimeType,
      duration_seconds: state.elapsedSeconds
    };

    if (uploadUrl) {
      payload.upload_url = uploadUrl;
    } else {
      // Legacy fallback if direct upload fails
      payload.audio_base64 = await getAudioBase64();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 75000); // 75s timeout for Apps Script execution

    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const res = await response.json();
    
    if (!res.ok) throw new Error(res.error || 'Server processing error.');

    displayCaseId.textContent = state.caseId;
    showStep(stepConfirm);

  } catch (err) {
    console.error('Submission failure:', err);
    showStep(stepRecord);
    if (err.name === 'AbortError') {
      showError('Network Timeout', 'The request timed out while processing transcription. Please check internet connection and try again.');
    } else {
      showError('Submission Error', err.message || 'Failed to submit feedback. Please try again.');
    }
  } finally {
    state.isSubmitting = false;
    btnSubmit.disabled = false;
  }
}

function resetRecordingState() {
  state.audioBase64 = '';
  state.recordedChunks = [];
  state.elapsedSeconds = 0;
  if (state.timerInterval) clearInterval(state.timerInterval);
}

function resetRecordingUI() {
  resetRecordingState();
  state.isRecording = false;
  state.isPaused = false;
  
  timerDisplay.textContent = '00:00';
  recordingStatus.textContent = 'Click "Start Recording" to speak';
  
  btnRecord.classList.remove('recording');
  btnRecord.disabled = false;
  if (btnRecordText) btnRecordText.textContent = 'Start Recording';
  
  const viz = document.querySelector('.wave-visualizer');
  if (viz) viz.classList.remove('recording');
  
  btnPause.classList.add('hidden');
  btnPause.textContent = 'Pause';
  btnStop.classList.add('hidden');
  submitActions.classList.add('hidden');
}

function resetFlow() {
  resetRecordingUI();
  showStep(stepConsent);
}

function copyCaseId() {
  navigator.clipboard.writeText(state.caseId).then(() => {
    btnCopyCase.textContent = 'Copied!';
    setTimeout(() => btnCopyCase.textContent = 'Copy', 2000);
  });
}

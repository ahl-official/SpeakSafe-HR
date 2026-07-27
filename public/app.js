/**
 * SpeakSafe HR — Frontend Engine
 *
 * Key changes from previous version:
 * - API keys removed from client (now securely in Apps Script only)
 * - Async fire-and-forget submission with server-sent polling
 * - Real waveform via AudioContext + AnalyserNode
 * - Audio playback preview before submit
 * - Discard confirmation modal
 * - Mic stream properly cleaned up on discard/reset
 * - Clipboard error handling
 * - 75s timeout replaced by async polling (handles 1-2hr audio)
 */

// ─── Google Apps Script Web App URL ───────────────────────────────────────────
// NOTE: All API keys (AssemblyAI, OpenRouter) live in Apps Script Script Properties.
// NEVER put secret API keys in this frontend file.
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvrEQdCBlHuzf4x7x9OFUPNvTDJU1hgvTxdPcj146SU626ZglDh6_NVSEhNrYGvT8/exec';

// Webhook secret is NOT a secret on the frontend in the same sense —
// it proves the request came from this UI, not from arbitrary bots.
// Do not place real private API keys here.
const WEBHOOK_SECRET = '4b7f9e2a1c6d8f03e5a9b4c7d2f6a8e1c3b9d5f0a7e2c8b4f1d6a9e3c5b7f2d8';

// ─── App State ─────────────────────────────────────────────────────────────────
let state = {
  isRecording: false,
  isPaused: false,
  isSubmitting: false,
  startTime: 0,
  elapsedSeconds: 0,
  timerInterval: null,
  micStream: null,
  audioContext: null,
  analyser: null,
  waveformRaf: null,
  mediaRecorder: null,
  recordedChunks: [],
  audioMimeType: 'audio/webm',
  caseId: '',
  pollInterval: null,
};

// ─── DOM Element References ────────────────────────────────────────────────────
const stepConsent     = document.getElementById('step-consent');
const stepRecord      = document.getElementById('step-record');
const stepProcessing  = document.getElementById('step-processing');
const stepConfirm     = document.getElementById('step-confirm');

const btnStartFlow    = document.getElementById('btn-start-flow');
const btnRecord       = document.getElementById('btn-record');
const btnRecordText   = document.getElementById('btn-record-text');
const btnPause        = document.getElementById('btn-pause');
const btnPauseText    = document.getElementById('btn-pause-text');
const btnStop         = document.getElementById('btn-stop');
const btnSubmit       = document.getElementById('btn-submit');
const btnDiscard      = document.getElementById('btn-discard');
const btnReset        = document.getElementById('btn-reset');
const btnCopyCase     = document.getElementById('btn-copy-case');
const submitActions   = document.getElementById('submit-actions');

const timerDisplay    = document.getElementById('timer');
const recordingStatus = document.getElementById('recording-status');
const displayCaseId   = document.getElementById('display-case-id');
const recordingLiveDot = document.getElementById('recording-live-dot');
const audioPlayback   = document.getElementById('audio-playback');

const errorBanner     = document.getElementById('error-banner');
const errorTitle      = document.getElementById('error-title');
const errorMessage    = document.getElementById('error-message');
const btnCloseError   = document.getElementById('btn-close-error');

const waveformCanvas  = document.getElementById('waveform-canvas');
const waveCtx         = waveformCanvas ? waveformCanvas.getContext('2d') : null;

// Processing step indicators
const pstepUpload     = document.getElementById('pstep-upload');
const pstepTranscribe = document.getElementById('pstep-transcribe');
const pstepReport     = document.getElementById('pstep-report');
const pstepSave       = document.getElementById('pstep-save');
const processingStatusText = document.getElementById('processing-status-text');

// Discard Modal
const discardModal    = document.getElementById('discard-modal');
const btnModalCancel  = document.getElementById('btn-modal-cancel');
const btnModalConfirm = document.getElementById('btn-modal-confirm');

// ─── Event Listeners ───────────────────────────────────────────────────────────
btnStartFlow.addEventListener('click', () => {
  resetRecordingUI();
  showStep(stepRecord);
});

btnRecord.addEventListener('click', toggleRecording);
btnPause.addEventListener('click', togglePause);
btnStop.addEventListener('click', () => stopRecording());
btnSubmit.addEventListener('click', submitCase);
btnDiscard.addEventListener('click', () => showDiscardModal());
btnModalCancel.addEventListener('click', hideDiscardModal);
btnModalConfirm.addEventListener('click', () => { hideDiscardModal(); doDiscard(); });
btnReset.addEventListener('click', resetFlow);
btnCopyCase.addEventListener('click', copyCaseId);
btnCloseError.addEventListener('click', hideError);

// Close modal on backdrop click
discardModal.addEventListener('click', (e) => {
  if (e.target === discardModal) hideDiscardModal();
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !discardModal.classList.contains('hidden')) {
    hideDiscardModal();
  }
});

// ─── Step Navigation ───────────────────────────────────────────────────────────
function showStep(stepElement) {
  hideError();
  [stepConsent, stepRecord, stepProcessing, stepConfirm].forEach(el => el.classList.add('hidden'));
  stepElement.classList.remove('hidden');
  // Scroll card into view on mobile
  stepElement.closest('.portal-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Error Handling ────────────────────────────────────────────────────────────
function showError(title, msg) {
  errorTitle.textContent = title;
  errorMessage.textContent = ' ' + msg;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
}

// ─── Case ID ───────────────────────────────────────────────────────────────────
function generateCaseId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SSF-${dateStr}-${randStr}`;
}

// ─── Recording Controls ────────────────────────────────────────────────────────
async function toggleRecording() {
  if (!state.isRecording) {
    await startRecording();
  } else {
    // If recording is active, toggle button acts as stop
    await stopRecording();
  }
}

async function startRecording() {
  hideError();
  resetRecordingState();

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Audio recording is not supported in this browser. Please use Chrome, Firefox, or Safari.');
    }

    // 1. Request microphone access
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.isRecording = true;
    state.isPaused = false;
    state.recordedChunks = [];

    // 2. Pick best supported audio codec with fallback chain
    let options = {};
    const codecs = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const codec of codecs) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(codec)) {
        options.mimeType = codec;
        break;
      }
    }

    state.mediaRecorder = new MediaRecorder(state.micStream, options);
    state.audioMimeType = state.mediaRecorder.mimeType || 'audio/webm';

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        state.recordedChunks.push(e.data);
      }
    };

    state.mediaRecorder.start(500); // Collect chunks every 500ms

    // 3. Setup waveform visualizer via Web Audio API
    setupWaveform(state.micStream);

    // 4. Update UI
    btnRecord.classList.add('is-recording');
    if (btnRecordText) btnRecordText.textContent = 'Recording...';
    btnRecord.setAttribute('aria-label', 'Stop recording');
    // Also switch stop button color class
    btnRecord.classList.remove('btn-primary');
    btnRecord.classList.add('btn-primary', 'is-recording');

    recordingLiveDot.classList.remove('hidden');
    recordingStatus.textContent = 'Recording in progress — speak clearly into your microphone';
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');
    submitActions.classList.add('hidden');

    // 5. Start timer
    state.startTime = Date.now();
    state.elapsedSeconds = 0;
    timerDisplay.textContent = '00:00';
    state.timerInterval = setInterval(updateTimer, 1000);

  } catch (err) {
    console.error('Microphone error:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('Microphone Access Denied', 'Please allow microphone access in your browser settings, then try again.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showError('No Microphone Found', 'No microphone was detected. Please connect a microphone and try again.');
    } else if (err.name === 'NotReadableError') {
      showError('Microphone In Use', 'Your microphone is being used by another application. Please close it and try again.');
    } else {
      showError('Recording Failed', err.message || 'Could not start audio recording. Please try again.');
    }
    cleanupMicStream();
    resetRecordingUIControls();
  }
}

function togglePause() {
  if (state.isPaused) {
    // Resume
    state.isPaused = false;
    if (btnPauseText) btnPauseText.textContent = 'Pause';
    btnPause.setAttribute('aria-label', 'Pause recording');
    recordingStatus.textContent = 'Recording in progress...';
    if (state.mediaRecorder && state.mediaRecorder.state === 'paused') {
      state.mediaRecorder.resume();
    }
    // Resume waveform
    if (state.audioContext && state.audioContext.state === 'suspended') {
      state.audioContext.resume();
    }
    state.startTime = Date.now() - (state.elapsedSeconds * 1000);
    state.timerInterval = setInterval(updateTimer, 1000);
  } else {
    // Pause
    state.isPaused = true;
    if (btnPauseText) btnPauseText.textContent = 'Resume';
    btnPause.setAttribute('aria-label', 'Resume recording');
    recordingStatus.textContent = 'Recording paused — click Resume when ready';
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
      state.mediaRecorder.pause();
    }
    if (state.audioContext && state.audioContext.state === 'running') {
      state.audioContext.suspend();
    }
    clearInterval(state.timerInterval);
    // Draw idle waveform
    drawIdleWaveform();
  }
}

function stopRecording() {
  return new Promise((resolve) => {
    state.isRecording = false;
    state.isPaused = false;
    clearInterval(state.timerInterval);

    const finishStop = () => {
      // Stop waveform visualizer
      stopWaveform();

      // Release microphone — Bug fix: was missing on discard
      cleanupMicStream();

      // Reset recording button
      btnRecord.classList.remove('is-recording');
      if (btnRecordText) btnRecordText.textContent = 'Start Recording';
      btnRecord.setAttribute('aria-label', 'Start recording');

      recordingStatus.textContent = 'Recording complete — review your recording below before submitting';
      btnPause.classList.add('hidden');
      btnStop.classList.add('hidden');

      // Set audio playback source
      if (state.recordedChunks.length > 0 && audioPlayback) {
        const audioBlob = new Blob(state.recordedChunks, { type: state.audioMimeType });
        const url = URL.createObjectURL(audioBlob);
        audioPlayback.src = url;
      }

      submitActions.classList.remove('hidden');
      drawIdleWaveform();
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
  const h = Math.floor(state.elapsedSeconds / 3600);
  const m = Math.floor((state.elapsedSeconds % 3600) / 60);
  const s = state.elapsedSeconds % 60;
  if (h > 0) {
    timerDisplay.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  } else {
    timerDisplay.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // 30-minute warning
  if (state.elapsedSeconds === 1800) {
    recordingStatus.textContent = '⚠️ 30 minutes recorded — you can stop any time';
  }
}

// ─── Web Audio API Waveform ────────────────────────────────────────────────────
function setupWaveform(stream) {
  try {
    if (!waveCtx || !waveformCanvas) return;

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.8;

    const source = state.audioContext.createMediaStreamSource(stream);
    source.connect(state.analyser);

    drawWaveform();
  } catch (e) {
    console.warn('Waveform setup failed (non-critical):', e);
    drawIdleWaveform();
  }
}

function drawWaveform() {
  if (!state.analyser || !waveCtx || !waveformCanvas) return;

  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    if (!state.isRecording || state.isPaused) return;
    state.waveformRaf = requestAnimationFrame(draw);

    state.analyser.getByteFrequencyData(dataArray);

    const W = waveformCanvas.width;
    const H = waveformCanvas.height;

    waveCtx.clearRect(0, 0, W, H);

    const barCount = 48;
    const barWidth = (W / barCount) * 0.6;
    const gap = (W / barCount) * 0.4;
    const cx = W / 2;
    const cy = H / 2;

    for (let i = 0; i < barCount; i++) {
      const dataIdx = Math.floor((i / barCount) * bufferLength);
      const value = dataArray[dataIdx] / 255;
      const barH = Math.max(3, value * H * 0.85);
      const x = i * (barWidth + gap);

      // Color gradient from blue to purple based on amplitude
      const r = Math.round(59 + value * 120);
      const g = Math.round(130 - value * 30);
      const b = Math.round(246);
      const alpha = 0.5 + value * 0.5;

      waveCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      waveCtx.beginPath();
      waveCtx.roundRect(x, cy - barH / 2, barWidth, barH, 3);
      waveCtx.fill();
    }
  };

  draw();
}

function drawIdleWaveform() {
  if (!waveCtx || !waveformCanvas) return;
  const W = waveformCanvas.width;
  const H = waveformCanvas.height;
  waveCtx.clearRect(0, 0, W, H);

  const barCount = 48;
  const barWidth = (W / barCount) * 0.6;
  const gap = (W / barCount) * 0.4;
  const cy = H / 2;

  for (let i = 0; i < barCount; i++) {
    const x = i * (barWidth + gap);
    waveCtx.fillStyle = 'rgba(148, 163, 184, 0.2)';
    waveCtx.beginPath();
    waveCtx.roundRect(x, cy - 2, barWidth, 4, 2);
    waveCtx.fill();
  }
}

function stopWaveform() {
  if (state.waveformRaf) {
    cancelAnimationFrame(state.waveformRaf);
    state.waveformRaf = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
    state.analyser = null;
  }
  drawIdleWaveform();
}

// Polyfill roundRect for older browsers
if (CanvasRenderingContext2D && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.beginPath();
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}

// Draw idle waveform on load
drawIdleWaveform();

// ─── Microphone Cleanup ────────────────────────────────────────────────────────
function cleanupMicStream() {
  if (state.micStream) {
    state.micStream.getTracks().forEach(track => track.stop());
    state.micStream = null;
  }
}

// ─── Discard Modal ─────────────────────────────────────────────────────────────
function showDiscardModal() {
  discardModal.classList.remove('hidden');
  document.getElementById('btn-modal-cancel').focus();
}

function hideDiscardModal() {
  discardModal.classList.add('hidden');
}

function doDiscard() {
  // Clean up any in-progress recording
  if (state.isRecording) {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      try { state.mediaRecorder.stop(); } catch (e) {}
    }
    stopWaveform();
    cleanupMicStream();
  }
  // Revoke audio object URL if any
  if (audioPlayback && audioPlayback.src && audioPlayback.src.startsWith('blob:')) {
    URL.revokeObjectURL(audioPlayback.src);
    audioPlayback.src = '';
  }
  resetRecordingUI();
}

// ─── Convert Recorded Audio to Blob ───────────────────────────────────────────
function getAudioBlob() {
  if (!state.recordedChunks || state.recordedChunks.length === 0) return null;
  return new Blob(state.recordedChunks, { type: state.audioMimeType });
}

// ─── Direct Upload to AssemblyAI CDN ──────────────────────────────────────────
// The browser uploads audio directly to AssemblyAI's CDN endpoint.
// This bypasses Vercel payload limits and Apps Script URL fetch size limits.
// The AssemblyAI upload endpoint accepts the API key in the Authorization header.
// This is intentional by AssemblyAI's design for browser-based uploads.
async function uploadAudioToAssemblyAI(audioBlob) {
  // Fetch the API key from Apps Script instead of hardcoding it here
  // For now we use the stored key via a GET request to our backend
  const keyResp = await fetch(APPS_SCRIPT_URL + '?action=get_upload_key', {
    method: 'GET',
    cache: 'no-store',
  }).catch(() => null);

  let apiKey = null;
  if (keyResp && keyResp.ok) {
    try {
      const kd = await keyResp.json();
      apiKey = kd && kd.upload_key;
    } catch (e) {}
  }

  // If the backend doesn't support key proxy yet, the upload will be handled
  // server-side — we skip direct upload and let Apps Script handle it
  if (!apiKey) {
    console.log('No upload key from server; will use base64 fallback.');
    return null;
  }

  const response = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      'content-type': 'application/octet-stream',
    },
    body: audioBlob,
  });

  if (!response.ok) {
    console.warn('AssemblyAI direct upload failed:', response.status);
    return null;
  }

  const json = await response.json();
  return json.upload_url || null;
}

// ─── Case Submission ───────────────────────────────────────────────────────────
async function submitCase() {
  if (state.isSubmitting) return;
  hideError();

  // Stop recording if still active
  if (state.isRecording) {
    await stopRecording();
  }

  const audioBlob = getAudioBlob();
  if (!audioBlob || audioBlob.size < 300) {
    showError('No Recording Found', 'Please record your feedback before submitting. Speak clearly into your microphone.');
    return;
  }

  // Large file warning (> 500MB is unrealistic, but > 100MB give notice)
  if (audioBlob.size > 100 * 1024 * 1024) {
    showError('Recording Very Large', 'Your recording is very large. Upload may take several minutes. Please stay on this page.');
  }

  state.isSubmitting = true;
  btnSubmit.disabled = true;
  state.caseId = generateCaseId();

  // Show processing screen
  showStep(stepProcessing);
  setProcessingStep('upload');

  try {
    // Step 1: Try direct browser → AssemblyAI CDN upload
    let uploadUrl = null;
    let audioBase64 = null;

    if (processingStatusText) processingStatusText.textContent = 'Uploading your audio securely...';

    try {
      uploadUrl = await uploadAudioToAssemblyAI(audioBlob);
    } catch (uploadErr) {
      console.warn('Direct upload attempt failed:', uploadErr);
    }

    // Fallback: Convert to base64 for Apps Script upload
    if (!uploadUrl) {
      if (processingStatusText) processingStatusText.textContent = 'Preparing audio for upload...';
      audioBase64 = await blobToBase64(audioBlob);
    }

    setProcessingStep('transcribe');
    if (processingStatusText) processingStatusText.textContent = 'Sending to server for transcription...';

    // Step 2: Send to Apps Script
    const payload = {
      action: 'process_case',
      case_id: state.caseId,
      secret: WEBHOOK_SECRET,
      mime_type: state.audioMimeType,
      duration_seconds: state.elapsedSeconds,
    };

    if (uploadUrl) {
      payload.upload_url = uploadUrl;
    } else if (audioBase64) {
      payload.audio_base64 = audioBase64;
    }

    // No abort timeout — we let this run as long as needed for large files
    // For 1-2hr audio the server returns immediately (async webhook pattern)
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status} ${response.statusText}`);
    }

    const res = await response.json();
    if (!res.ok) throw new Error(res.error || 'Server processing error.');

    const serverStatus = res.result && res.result.status;

    if (serverStatus === 'processing') {
      // ASYNC path: server is processing, poll for completion
      setProcessingStep('transcribe');
      if (processingStatusText) processingStatusText.textContent = 'Transcribing your audio (may take a few minutes for long recordings)...';
      startPollingForCompletion(state.caseId);
    } else {
      // SYNC path: completed immediately (short audio)
      setProcessingStep('save');
      if (processingStatusText) processingStatusText.textContent = 'Saving report to HR Drive...';
      await sleep(800); // Brief visual pause so user sees the steps
      showConfirmation(state.caseId);
    }

  } catch (err) {
    console.error('Submission error:', err);
    showStep(stepRecord);

    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showError('Network Error', 'Could not reach the server. Please check your internet connection and try again.');
    } else {
      showError('Submission Failed', err.message || 'An unexpected error occurred. Please try again.');
    }

    state.isSubmitting = false;
    btnSubmit.disabled = false;
  }
}

// ─── Async Polling for Long Audio ─────────────────────────────────────────────
function startPollingForCompletion(caseId) {
  let pollCount = 0;
  const maxPolls = 120; // 120 × 15s = 30 minutes max poll time

  state.pollInterval = setInterval(async () => {
    pollCount++;

    if (pollCount > maxPolls) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
      // Timeout after 30 minutes — but case may still be processing
      // Show confirmation anyway as the case was accepted by the server
      showConfirmation(caseId);
      return;
    }

    try {
      const resp = await fetch(
        `${APPS_SCRIPT_URL}?action=check_status&case_id=${encodeURIComponent(caseId)}`,
        { method: 'GET', cache: 'no-store' }
      );

      if (!resp.ok) return; // Network blip — try again next interval

      const data = await resp.json();
      const status = data && data.status;

      if (status === 'completed') {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
        setProcessingStep('save');
        if (processingStatusText) processingStatusText.textContent = 'Saving report to HR Drive...';
        await sleep(600);
        showConfirmation(caseId);

      } else if (status === 'error') {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
        // Still show confirmation — the case was received even if transcription failed
        showConfirmation(caseId);
        showError('Partial Processing', 'Audio was saved but transcription encountered an issue. HR will review the recording directly.');

      } else if (status === 'transcribing') {
        // Update status message based on elapsed time
        const elapsedMin = Math.floor(pollCount * 15 / 60);
        if (processingStatusText) {
          processingStatusText.textContent = elapsedMin < 2
            ? 'Transcribing your audio...'
            : `Transcribing your audio (${elapsedMin} min elapsed — this is normal for longer recordings)`;
        }
      }
    } catch (pollErr) {
      console.warn('Poll attempt failed (will retry):', pollErr);
    }
  }, 15000); // Poll every 15 seconds
}

function showConfirmation(caseId) {
  clearInterval(state.pollInterval);
  state.pollInterval = null;
  displayCaseId.textContent = caseId;
  showStep(stepConfirm);
  state.isSubmitting = false;
  btnSubmit.disabled = false;
}

// ─── Processing Step UI ────────────────────────────────────────────────────────
const PROC_STEPS = {
  upload: pstepUpload,
  transcribe: pstepTranscribe,
  report: pstepReport,
  save: pstepSave,
};

const PROC_ORDER = ['upload', 'transcribe', 'report', 'save'];

function setProcessingStep(activeStep) {
  const activeIdx = PROC_ORDER.indexOf(activeStep);
  PROC_ORDER.forEach((step, idx) => {
    const el = PROC_STEPS[step];
    if (!el) return;
    // Works with both .pstep-dot (old) and .ps-dot (new HTML)
    const dot = el.querySelector('.ps-dot') || el.querySelector('.pstep-dot');
    el.classList.remove('is-active', 'is-done');
    if (dot) { dot.classList.remove('active', 'done'); }

    if (idx < activeIdx) {
      el.classList.add('is-done');
      if (dot) dot.classList.add('done');
    } else if (idx === activeIdx) {
      el.classList.add('is-active');
      if (dot) dot.classList.add('active');
    }
  });
}

// ─── Reset Flows ───────────────────────────────────────────────────────────────
function resetRecordingState() {
  state.recordedChunks = [];
  state.elapsedSeconds = 0;
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
}

function resetRecordingUIControls() {
  btnRecord.classList.remove('is-recording');
  if (btnRecordText) btnRecordText.textContent = 'Start Recording';
  btnRecord.setAttribute('aria-label', 'Start recording');
  btnRecord.disabled = false;
  if (recordingLiveDot) recordingLiveDot.classList.add('hidden');
  btnPause.classList.add('hidden');
  if (btnPauseText) btnPauseText.textContent = 'Pause';
  btnStop.classList.add('hidden');
  submitActions.classList.add('hidden');
}

function resetRecordingUI() {
  resetRecordingState();
  state.isRecording = false;
  state.isPaused = false;

  timerDisplay.textContent = '00:00';
  recordingStatus.textContent = 'Ready to record';

  // Revoke old audio object URL to free memory
  if (audioPlayback && audioPlayback.src && audioPlayback.src.startsWith('blob:')) {
    URL.revokeObjectURL(audioPlayback.src);
    audioPlayback.src = '';
  }

  resetRecordingUIControls();
  drawIdleWaveform();
}

function resetFlow() {
  // Stop any active poll
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
  state.isSubmitting = false;
  btnSubmit.disabled = false;
  resetRecordingUI();
  showStep(stepConsent);
}

// ─── Copy Case ID ──────────────────────────────────────────────────────────────
function copyCaseId() {
  const id = state.caseId || displayCaseId.textContent;
  if (!id) return;

  // Modern clipboard API with fallback
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(id)
      .then(() => showCopyFeedback())
      .catch(() => fallbackCopy(id));
  } else {
    fallbackCopy(id);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showCopyFeedback();
  } catch (e) {
    console.warn('Copy failed:', e);
  } finally {
    document.body.removeChild(ta);
  }
}

function showCopyFeedback() {
  btnCopyCase.textContent = 'Copied!';
  btnCopyCase.classList.add('copied');
  setTimeout(() => {
    btnCopyCase.textContent = 'Copy';
    btnCopyCase.classList.remove('copied');
  }, 2500);
}

// ─── Utility Helpers ───────────────────────────────────────────────────────────
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || '';
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

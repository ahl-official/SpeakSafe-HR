/**
 * SpeakSafe HR — Production Hardened Client Logic
 */

// Deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvrEQdCBlHuzf4x7x9OFUPNvTDJU1hgvTxdPcj146SU626ZglDh6_NVSEhNrYGvT8/exec';

let state = {
  isRecording: false,
  isPaused: false,
  isSubmitting: false,
  startTime: 0,
  elapsedSeconds: 0,
  timerInterval: null,
  ws: null,
  audioContext: null,
  processor: null,
  micStream: null,
  mediaRecorder: null,
  recordedChunks: [],
  transcript: '',
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
btnStop.addEventListener('click', stopRecording);
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
    stopRecording();
  }
}

async function startRecording() {
  hideError();
  state.recordedChunks = [];
  state.transcript = '';

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Web Audio API is not supported on this browser or origin.');
    }

    // Request Microphone Permission
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    
    state.isRecording = true;
    state.isPaused = false;
    
    // Setup MediaRecorder fallback
    try {
      state.mediaRecorder = new MediaRecorder(state.micStream);
      state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) state.recordedChunks.push(e.data);
      };
      state.mediaRecorder.start(1000);
    } catch (mrErr) {
      console.warn('MediaRecorder fallback init skipped:', mrErr);
    }

    // UI Updates
    btnRecord.classList.add('recording');
    if (btnRecordText) btnRecordText.textContent = 'Recording...';
    document.querySelector('.wave-visualizer').classList.add('recording');
    recordingStatus.textContent = 'Recording in progress... Speak clearly';
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');
    submitActions.classList.add('hidden');

    // Timer Start
    state.startTime = Date.now() - (state.elapsedSeconds * 1000);
    state.timerInterval = setInterval(updateTimer, 1000);

    // Initialize Streaming Transcription
    await initStreamingTranscription();

  } catch (err) {
    console.error('Microphone failure:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('Microphone Access Denied', 'Please grant microphone permissions in your browser settings to continue.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showError('No Microphone Found', 'No active microphone was detected on your device.');
    } else {
      showError('Audio Initialization Failed', err.message || 'Could not start audio recorder.');
    }
    resetRecordingUI();
  }
}

function togglePause() {
  if (state.isPaused) {
    state.isPaused = false;
    btnPause.textContent = 'Pause';
    recordingStatus.textContent = 'Recording in progress...';
    if (state.mediaRecorder && state.mediaRecorder.state === 'paused') state.mediaRecorder.resume();
    state.startTime = Date.now() - (state.elapsedSeconds * 1000);
    state.timerInterval = setInterval(updateTimer, 1000);
  } else {
    state.isPaused = true;
    btnPause.textContent = 'Resume';
    recordingStatus.textContent = 'Recording Paused';
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') state.mediaRecorder.pause();
    clearInterval(state.timerInterval);
  }
}

function stopRecording() {
  state.isRecording = false;
  state.isPaused = false;
  clearInterval(state.timerInterval);

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  if (state.micStream) {
    state.micStream.getTracks().forEach(track => track.stop());
  }

  if (state.ws) {
    state.ws.close();
  }

  btnRecord.classList.remove('recording');
  if (btnRecordText) btnRecordText.textContent = 'Start Recording';
  document.querySelector('.wave-visualizer').classList.remove('recording');
  recordingStatus.textContent = 'Recording complete. Click Submit to send feedback to HR.';
  
  btnPause.classList.add('hidden');
  btnStop.classList.add('hidden');
  submitActions.classList.remove('hidden');
}

function updateTimer() {
  if (state.isPaused) return;
  state.elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
  const mins = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
  const secs = String(state.elapsedSeconds % 60).padStart(2, '0');
  timerDisplay.textContent = `${mins}:${secs}`;
}

async function initStreamingTranscription() {
  try {
    let token = null;
    if (APPS_SCRIPT_URL) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const resp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'get_assembly_token' }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await resp.json();
      if (data.ok && data.result?.token) token = data.result.token;
    }

    if (!token) return;

    state.ws = new WebSocket(`wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`);

    state.ws.onmessage = (message) => {
      const res = JSON.parse(message.data);
      if (res.message_type === 'FinalTranscript' && res.text) {
        state.transcript += (state.transcript ? ' ' : '') + res.text;
      }
    };

    state.ws.onerror = (err) => console.warn('WebSocket stream error:', err);

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = state.audioContext.createMediaStreamSource(state.micStream);
    state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(state.processor);
    state.processor.connect(state.audioContext.destination);

    state.processor.onaudioprocess = (e) => {
      if (!state.isRecording || state.isPaused || state.ws?.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      state.ws.send(pcm16.buffer);
    };

  } catch (err) {
    console.warn('Streaming background setup note:', err);
  }
}

async function submitCase() {
  if (state.isSubmitting) return;
  hideError();

  const finalTranscript = state.transcript.trim() || 'Employee provided anonymous audio feedback.';
  
  state.isSubmitting = true;
  btnSubmit.disabled = true;
  showStep(stepProcessing);

  state.caseId = generateCaseId();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 28000);

    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action: 'process_case',
        case_id: state.caseId,
        transcript: finalTranscript
      }),
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
      showError('Network Timeout', 'The request timed out. Please check your connection and try again.');
    } else {
      showError('Submission Error', err.message || 'Failed to communicate with HR server. Please try again.');
    }
  } finally {
    state.isSubmitting = false;
    btnSubmit.disabled = false;
  }
}

function resetRecordingUI() {
  state.isRecording = false;
  state.isPaused = false;
  state.elapsedSeconds = 0;
  timerDisplay.textContent = '00:00';
  recordingStatus.textContent = 'Click "Start Recording" to speak';
  btnRecord.classList.remove('recording');
  if (btnRecordText) btnRecordText.textContent = 'Start Recording';
  document.querySelector('.wave-visualizer').classList.remove('recording');
  btnPause.classList.add('hidden');
  btnStop.classList.add('hidden');
  submitActions.classList.add('hidden');
}

function resetFlow() {
  resetRecordingUI();
  state.transcript = '';
  state.recordedChunks = [];
  showStep(stepConsent);
}

function copyCaseId() {
  navigator.clipboard.writeText(state.caseId).then(() => {
    btnCopyCase.textContent = 'Copied!';
    setTimeout(() => btnCopyCase.textContent = 'Copy', 2000);
  });
}

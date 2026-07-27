/**
 * SpeakSafe HR — Client Application Logic
 */

// Deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvrEQdCBlHuzf4x7x9OFUPNvTDJU1hgvTxdPcj146SU626ZglDh6_NVSEhNrYGvT8/exec';

let state = {
  isRecording: false,
  isPaused: false,
  startTime: 0,
  elapsedSeconds: 0,
  timerInterval: null,
  ws: null,
  audioContext: null,
  processor: null,
  micStream: null,
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
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const btnSubmit = document.getElementById('btn-submit');
const btnReset = document.getElementById('btn-reset');
const btnCopyCase = document.getElementById('btn-copy-case');

const timerDisplay = document.getElementById('timer');
const recordingStatus = document.getElementById('recording-status');
const transcriptBox = document.getElementById('transcript-box');
const wordCountDisplay = document.getElementById('word-count');
const displayCaseId = document.getElementById('display-case-id');

// Event Listeners
btnStartFlow.addEventListener('click', () => showStep(stepRecord));
btnRecord.addEventListener('click', toggleRecording);
btnPause.addEventListener('click', togglePause);
btnStop.addEventListener('click', stopRecording);
btnSubmit.addEventListener('click', submitCase);
btnReset.addEventListener('click', resetFlow);
btnCopyCase.addEventListener('click', copyCaseId);

transcriptBox.addEventListener('input', updateWordCount);

function showStep(stepElement) {
  [stepConsent, stepRecord, stepProcessing, stepConfirm].forEach(el => el.classList.add('hidden'));
  stepElement.classList.remove('hidden');
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
  try {
    // Request Microphone Permission
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.isRecording = true;
    state.isPaused = false;
    
    // UI Updates
    btnRecord.classList.add('recording');
    document.querySelector('.recorder-box').classList.add('recording');
    recordingStatus.textContent = 'Listening... Speak into your microphone';
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');

    // Timer Start
    state.startTime = Date.now() - (state.elapsedSeconds * 1000);
    state.timerInterval = setInterval(updateTimer, 1000);

    // Initialize AssemblyAI Real-Time WebSocket
    await initStreamingTranscription();

  } catch (err) {
    console.error('Microphone error:', err);
    alert('Microphone access is required to record feedback. Please check your browser permissions.');
    resetRecordingUI();
  }
}

function togglePause() {
  if (state.isPaused) {
    state.isPaused = false;
    btnPause.textContent = 'Pause';
    recordingStatus.textContent = 'Listening... Speak into your microphone';
    state.startTime = Date.now() - (state.elapsedSeconds * 1000);
    state.timerInterval = setInterval(updateTimer, 1000);
  } else {
    state.isPaused = true;
    btnPause.textContent = 'Resume';
    recordingStatus.textContent = 'Recording Paused';
    clearInterval(state.timerInterval);
  }
}

function stopRecording() {
  state.isRecording = false;
  state.isPaused = false;
  clearInterval(state.timerInterval);

  if (state.micStream) {
    state.micStream.getTracks().forEach(track => track.stop());
  }

  if (state.ws) {
    state.ws.close();
  }

  btnRecord.classList.remove('recording');
  document.querySelector('.recorder-box').classList.remove('recording');
  recordingStatus.textContent = 'Recording finished. Review transcript below before submitting.';
  
  btnPause.classList.add('hidden');
  btnSubmit.classList.remove('hidden');
}

function updateTimer() {
  if (state.isPaused) return;
  state.elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
  const mins = String(Math.floor(state.elapsedSeconds / 60)).padStart(2, '0');
  const secs = String(state.elapsedSeconds % 60).padStart(2, '0');
  timerDisplay.textContent = `${mins}:${secs}`;
}

/**
 * AssemblyAI Streaming Setup via WebSockets
 */
async function initStreamingTranscription() {
  try {
    // 1. Fetch temporary token from Apps Script
    let token = null;
    if (APPS_SCRIPT_URL) {
      const resp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'get_assembly_token' })
      });
      const data = await resp.json();
      if (data.ok && data.result?.token) token = data.result.token;
    }

    if (!token) {
      console.warn('AssemblyAI token unavailable. Manual text editing enabled.');
      return;
    }

    // 2. Open AssemblyAI WebSocket
    state.ws = new WebSocket(`wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`);

    state.ws.onmessage = (message) => {
      const res = JSON.parse(message.data);
      if (res.message_type === 'FinalTranscript' && res.text) {
        state.transcript += (state.transcript ? ' ' : '') + res.text;
        transcriptBox.textContent = state.transcript;
        updateWordCount();
      }
    };

    state.ws.onerror = (err) => console.error('WebSocket error:', err);

    // 3. AudioWorklet/ScriptProcessor PCM 16kHz Streaming
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = state.audioContext.createMediaStreamSource(state.micStream);
    state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(state.processor);
    state.processor.connect(state.audioContext.destination);

    state.processor.onaudioprocess = (e) => {
      if (!state.isRecording || state.isPaused || state.ws?.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Convert float32 PCM to int16 PCM
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      state.ws.send(pcm16.buffer);
    };

  } catch (err) {
    console.warn('Streaming STT initialization error:', err);
  }
}

function updateWordCount() {
  const text = transcriptBox.textContent.trim();
  const count = text ? text.split(/\s+/).length : 0;
  wordCountDisplay.textContent = `${count} words`;
}

async function submitCase() {
  const transcriptText = transcriptBox.textContent.trim();
  if (!transcriptText || transcriptText.length < 5) {
    alert('Please record or enter feedback before submitting.');
    return;
  }

  showStep(stepProcessing);

  state.caseId = generateCaseId();

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action: 'process_case',
        case_id: state.caseId,
        transcript: transcriptText
      })
    });
    const res = await response.json();
    if (!res.ok) throw new Error(res.error || 'Failed to submit case.');

    displayCaseId.textContent = state.caseId;
    showStep(stepConfirm);

  } catch (err) {
    console.error('Submission failed:', err);
    alert(`Submission Error: ${err.message || 'Network error. Please try again.'}`);
    showStep(stepRecord);
  }
}

function resetRecordingUI() {
  state.isRecording = false;
  state.isPaused = false;
  state.elapsedSeconds = 0;
  timerDisplay.textContent = '00:00';
  recordingStatus.textContent = 'Tap mic to start recording';
  btnRecord.classList.remove('recording');
  document.querySelector('.recorder-box').classList.remove('recording');
  btnPause.classList.add('hidden');
  btnStop.classList.add('hidden');
  btnSubmit.classList.add('hidden');
}

function resetFlow() {
  resetRecordingUI();
  state.transcript = '';
  transcriptBox.textContent = '';
  updateWordCount();
  showStep(stepConsent);
}

function copyCaseId() {
  navigator.clipboard.writeText(state.caseId).then(() => {
    btnCopyCase.textContent = 'Copied!';
    setTimeout(() => btnCopyCase.textContent = 'Copy', 2000);
  });
}

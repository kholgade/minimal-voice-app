'use strict';

// ── Constants ───────────────────────────────────────────
const PAUSE_RMS_THRESHOLD = 6;      // silence level (same as conversation VAD)
const PAUSE_DURATION_MS   = 2000;   // 2 s of silence → chunk boundary
const MAX_CHUNK_BYTES     = 50 * 1024 * 1024; // 50 MB hard cap

// ── State ───────────────────────────────────────────────
let isRecording       = false;
let sessionId         = null;
let mediaRecorder     = null;
let audioChunks       = [];        // Blob parts for current chunk
let chunkAccumBytes   = 0;
let chunkIndex        = 0;
let chunkStartSec     = 0;         // wall-clock offset of current chunk start (seconds)
let recordingStartMs  = 0;         // Date.now() when recording began
let timerRaf          = null;

// VAD
let vadAudioCtx  = null;
let vadAnalyser  = null;
let vadRafId     = null;
let pauseTimer   = null;           // setTimeout handle for 2 s silence
let pauseStartMs = null;           // when silence began (for timestamp noting)
let mimeType     = 'audio/webm';
let stream       = null;

// ── UI helpers ──────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setHint(text) { $('rec-hint').textContent = text; }

function updateTimer() {
  if (!isRecording) return;
  const elapsed = Math.floor((Date.now() - recordingStartMs) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  $('rec-timer').textContent = `${m}:${s}`;
  timerRaf = requestAnimationFrame(updateTimer);
}

function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function appendLiveSegments(segments) {
  if (!segments.length) return;
  $('live-transcript-wrap').classList.remove('hidden');
  const container = $('live-transcript');
  segments.forEach(seg => {
    const row = document.createElement('div');
    row.className = 'tr-segment';
    row.innerHTML =
      `<span class="tr-ts">[${fmtTime(seg.start)}]</span>` +
      `<span class="tr-text">${escHtml(seg.text)}</span>`;
    container.appendChild(row);
  });
  container.scrollTop = container.scrollHeight;
  $('chunk-badge').textContent = `chunk ${chunkIndex}`;
}

function renderFullTranscript(segments, fullText) {
  $('live-transcript-wrap').classList.add('hidden');
  const wrap = $('full-transcript-wrap');
  wrap.classList.remove('hidden');
  const container = $('full-transcript');
  container.innerHTML = '';
  segments.forEach(seg => {
    const row = document.createElement('div');
    row.className = 'tr-segment';
    row.innerHTML =
      `<span class="tr-ts">[${fmtTime(seg.start)}]</span>` +
      `<span class="tr-text">${escHtml(seg.text)}</span>`;
    container.appendChild(row);
  });
  // stash for copy/download
  container.dataset.plain = fullText;
}

function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Copy / Download ─────────────────────────────────────
function copyTranscript() {
  const text = $('full-transcript').dataset.plain || '';
  navigator.clipboard.writeText(text).catch(() => {});
}

function downloadTranscript() {
  const text = $('full-transcript').dataset.plain || '';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `${sessionId || 'recording'}.txt`;
  a.click();
}

// ── Toggle ──────────────────────────────────────────────
async function toggleRecording() {
  if (isRecording) await stopRecording();
  else             await startRecording();
}

// ── Start ───────────────────────────────────────────────
async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setHint('Microphone access denied.');
    return;
  }

  // Create session on server
  try {
    const r = await fetch('/api/recording/start', { method: 'POST' });
    sessionId = (await r.json()).sessionId;
  } catch {
    setHint('Could not start session.');
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  // VAD setup
  vadAudioCtx = new AudioContext();
  vadAnalyser = vadAudioCtx.createAnalyser();
  vadAnalyser.fftSize = 512;
  vadAudioCtx.createMediaStreamSource(stream).connect(vadAnalyser);

  mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
  chunkIndex      = 0;
  chunkStartSec   = 0;
  recordingStartMs = Date.now();
  isRecording     = true;

  // UI
  $('rec-btn').classList.add('active');
  $('rec-icon').classList.add('hidden');
  $('stop-icon').classList.remove('hidden');
  $('full-transcript-wrap').classList.add('hidden');
  $('live-transcript').innerHTML = '';
  $('live-transcript-wrap').classList.add('hidden');
  setHint('Recording… click to stop');
  updateTimer();

  startMediaRecorder();
  monitorPause();
}

// ── MediaRecorder lifecycle ─────────────────────────────
function startMediaRecorder() {
  audioChunks      = [];
  chunkAccumBytes  = 0;
  mediaRecorder    = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data);
      chunkAccumBytes += e.data.size;
      // Force flush if approaching 50 MB
      if (chunkAccumBytes >= MAX_CHUNK_BYTES && isRecording) {
        flushChunk('size limit');
      }
    }
  };

  mediaRecorder.onstop = async () => {
    const blob       = new Blob(audioChunks, { type: mimeType });
    const thisIndex  = chunkIndex++;
    const thisStart  = chunkStartSec;
    // next chunk starts at current elapsed time
    chunkStartSec    = (Date.now() - recordingStartMs) / 1000;
    audioChunks      = [];
    chunkAccumBytes  = 0;

    if (blob.size > 0) {
      const segments = await uploadChunk(blob, thisIndex, thisStart);
      appendLiveSegments(segments);
    }

    // Restart if still recording
    if (isRecording) startMediaRecorder();
  };

  mediaRecorder.start(500); // collect data every 500 ms for size tracking
}

// ── Pause VAD ───────────────────────────────────────────
function monitorPause() {
  if (!isRecording || !vadAnalyser) return;

  const buf = new Uint8Array(vadAnalyser.fftSize);
  vadAnalyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += (v - 128) ** 2;
  const rms = Math.sqrt(sum / buf.length);

  if (rms < PAUSE_RMS_THRESHOLD) {
    if (!pauseTimer) {
      pauseStartMs = Date.now(); // note when silence began
      pauseTimer = setTimeout(() => {
        if (isRecording) flushChunk('pause');
      }, PAUSE_DURATION_MS);
    }
  } else {
    // Speech resumed — cancel pending flush
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer    = null;
      pauseStartMs  = null;
    }
  }

  vadRafId = requestAnimationFrame(monitorPause);
}

function flushChunk(reason) {
  clearTimeout(pauseTimer);
  pauseTimer   = null;
  pauseStartMs = null;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // → onstop sends chunk + restarts
  }
}

// ── Upload chunk ────────────────────────────────────────
async function uploadChunk(blob, index, startSec) {
  const ext  = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('audio',      blob, `chunk.${ext}`);
  form.append('sessionId',  sessionId);
  form.append('chunkIndex', index);
  form.append('chunkStart', startSec.toFixed(2));
  try {
    const res = await fetch('/api/recording/chunk', { method: 'POST', body: form });
    const { segments } = await res.json();
    return segments || [];
  } catch {
    return [];
  }
}

// ── Stop ────────────────────────────────────────────────
async function stopRecording() {
  isRecording = false;

  // Stop VAD
  cancelAnimationFrame(vadRafId);
  clearTimeout(pauseTimer);
  pauseTimer = null;

  // Stop timer
  cancelAnimationFrame(timerRaf);

  // Flush final chunk
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    await new Promise(resolve => {
      mediaRecorder.onstop = async () => {
        const blob      = new Blob(audioChunks, { type: mimeType });
        const thisIndex = chunkIndex++;
        const thisStart = chunkStartSec;
        audioChunks     = [];
        if (blob.size > 0) {
          const segments = await uploadChunk(blob, thisIndex, thisStart);
          appendLiveSegments(segments);
        }
        resolve();
      };
      mediaRecorder.stop();
    });
  }

  // Stop mic
  if (vadAudioCtx) { vadAudioCtx.close(); vadAudioCtx = vadAnalyser = null; }
  stream?.getTracks().forEach(t => t.stop());
  stream = null;

  // UI
  $('rec-btn').classList.remove('active');
  $('rec-icon').classList.remove('hidden');
  $('stop-icon').classList.add('hidden');
  setHint('Processing full transcript…');

  // Assemble full transcript on server
  try {
    const res  = await fetch('/api/recording/stop', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId }),
    });
    const { segments, fullText } = await res.json();
    renderFullTranscript(segments || [], fullText || '');
    setHint('Recording complete. Click to start a new recording.');
    loadSessions();
  } catch {
    setHint('Error assembling transcript.');
  }
}

// ── Past sessions ───────────────────────────────────────
async function loadSessions() {
  try {
    const { sessions } = await fetch('/api/recording/sessions').then(r => r.json());
    const list = $('session-list-rec');
    list.innerHTML = '';
    if (!sessions.length) {
      list.innerHTML = '<p class="rec-empty">No recordings yet.</p>';
      return;
    }
    sessions.forEach(s => {
      const card = document.createElement('div');
      card.className = 'rec-session-card';
      const date  = new Date(s.startTime).toLocaleString();
      const label = s.status === 'complete' ? 'Complete' : 'In progress';
      card.innerHTML = `
        <div class="rsc-date">${escHtml(date)}</div>
        <div class="rsc-status ${s.status}">${label}</div>
        <div class="rsc-chunks">${s.chunks.length} chunk(s)</div>`;
      card.addEventListener('click', () => openSession(s.sessionId));
      list.appendChild(card);
    });
  } catch {}
}

async function openSession(id) {
  try {
    const data = await fetch(`/api/recording/${id}`).then(r => r.json());
    if (data.transcript) {
      renderFullTranscript(data.transcript.segments || [], data.transcript.fullText || '');
      $('rec-timer').textContent = '—';
    }
  } catch {}
}

// ── Init ────────────────────────────────────────────────
loadSessions();

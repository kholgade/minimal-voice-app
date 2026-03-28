'use strict';

// ── State ──────────────────────────────────────────────
let ws = null;
let mediaRecorder = null;
let audioChunks = [];
let audioQueue = [];
let isPlaying = false;
let assistantBubble = null;
let isRecording = false;
let silenceTimer = null;
let vadAnalyser = null;
let vadAudioCtx = null;
let vadRafId = null;
let sessions = [];         // local session list
let currentSessionId = null;

const SILENCE_THRESHOLD = 6;
const SILENCE_DELAY_MS  = 3000;

// ── WebSocket ──────────────────────────────────────────
function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    setStatus('Ready', 'ok');
  };

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'session':
        currentSessionId = msg.id;
        addSessionCard('New Conversation', msg.id);
        break;
      case 'user_text':
        addMessage('user', msg.text);
        break;
      case 'llm_chunk':
        appendChunk(msg.text);
        break;
      case 'audio_chunk':
        enqueueAudio(msg.audio);
        break;
      case 'response_done':
        finalizeResponse();
        break;
      case 'conversation_cleared':
        document.getElementById('messages').innerHTML = '';
        clearInspector();
        setStatus('Ready', 'ok');
        break;
      case 'status': {
        const map = { thinking: ['Thinking…', 'busy'], responding: ['Responding…', 'busy'], idle: ['Ready', 'ok'] };
        const [txt, cls] = map[msg.state] ?? [msg.state, ''];
        setStatus(txt, cls);
        setInputDisabled(msg.state !== 'idle');
        break;
      }
      case 'error':
        setStatus('Error', 'error');
        setInputDisabled(false);
        break;
    }
  };

  ws.onclose = () => {
    setStatus('Disconnected', 'error');
    setTimeout(connect, 2000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Status ─────────────────────────────────────────────
function setStatus(text, cls) {
  const dot  = document.getElementById('status-dot');
  const span = document.getElementById('status-text');
  const conn = document.getElementById('conn-dot');
  dot.className  = `sdot ${cls}`;
  conn.className = `conn-dot ${cls}`;
  span.textContent = text;
}

function setInputDisabled(disabled) {
  document.getElementById('text-field').disabled = disabled;
  document.getElementById('send-btn').disabled   = disabled;
  document.getElementById('mic-btn').disabled    = disabled;
  document.getElementById('input-bar').style.opacity = disabled ? '.5' : '1';
}

// ── Chat UI ────────────────────────────────────────────
function addMessage(role, text) {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;

  const av = document.createElement('div');
  av.className = `avatar ${role === 'user' ? 'user' : 'ai'}`;
  av.textContent = role === 'user' ? 'U' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  wrap.appendChild(av);
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;

  if (role === 'assistant') assistantBubble = bubble;
  return bubble;
}

function appendChunk(text) {
  if (!assistantBubble) assistantBubble = addMessage('assistant', '');
  assistantBubble.textContent += text;
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

function finalizeResponse() {
  if (assistantBubble) updateInspector(assistantBubble.textContent);
  assistantBubble = null;
}

// ── Inspector ──────────────────────────────────────────
function updateInspector(responseText) {
  // Extract rough bullet points from response (sentences → bullets)
  const sentences = responseText
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20)
    .slice(0, 4);

  const list = document.getElementById('summary-list');
  list.innerHTML = sentences.map(s => `<li>${escHtml(s)}</li>`).join('');
}

function clearInspector() {
  document.getElementById('summary-list').innerHTML =
    '<li class="muted">Start a conversation to see summaries.</li>';
  document.getElementById('action-items').innerHTML =
    '<label class="action-item muted"><input type="checkbox" disabled> Nothing extracted yet</label>';
}

// ── Text input ─────────────────────────────────────────
function sendText() {
  const field = document.getElementById('text-field');
  const text = field.value.trim();
  if (!text || field.disabled) return;
  field.value = '';
  send({ type: 'text_input', text });
}

// ── Recording + VAD ───────────────────────────────────
async function toggleRecording() {
  if (isRecording) stopRecording();
  else await startRecording();
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus('Mic denied', 'error');
    return;
  }

  vadAudioCtx = new AudioContext();
  vadAnalyser = vadAudioCtx.createAnalyser();
  vadAnalyser.fftSize = 512;
  vadAudioCtx.createMediaStreamSource(stream).connect(vadAnalyser);

  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
  mediaRecorder = new MediaRecorder(stream, { mimeType });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    vadAudioCtx.close();
    vadAudioCtx = vadAnalyser = null;
    uploadAudio(mimeType);
  };

  mediaRecorder.start();
  isRecording = true;

  document.getElementById('mic-btn').classList.add('active');
  document.getElementById('input-bar').classList.add('recording');
  document.getElementById('waveform').classList.remove('hidden');
  document.getElementById('mic-svg').classList.add('hidden');
  document.getElementById('text-field').placeholder = 'Listening…';
  setStatus('Listening…', 'busy');
  monitorSilence();
}

function monitorSilence() {
  if (!isRecording || !vadAnalyser) return;
  const buf = new Uint8Array(vadAnalyser.fftSize);
  vadAnalyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += (v - 128) ** 2;
  const rms = Math.sqrt(sum / buf.length);

  if (rms < SILENCE_THRESHOLD) {
    if (!silenceTimer)
      silenceTimer = setTimeout(() => { if (isRecording) stopRecording(); }, SILENCE_DELAY_MS);
  } else {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  vadRafId = requestAnimationFrame(monitorSilence);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(silenceTimer); silenceTimer = null;
  cancelAnimationFrame(vadRafId);
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();

  document.getElementById('mic-btn').classList.remove('active');
  document.getElementById('input-bar').classList.remove('recording');
  document.getElementById('waveform').classList.add('hidden');
  document.getElementById('mic-svg').classList.remove('hidden');
  document.getElementById('text-field').placeholder = 'Ask anything…';
  setStatus('Transcribing…', 'busy');
}

async function uploadAudio(mimeType) {
  const ext  = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  const form = new FormData();
  form.append('audio', blob, `audio.${ext}`);
  try {
    const res = await fetch('/api/transcribe', { method: 'POST', body: form });
    const { text, error } = await res.json();
    if (error || !text?.trim()) {
      hideGhost();
      setStatus('No speech detected', 'ok');
      return;
    }
    showGhost(text.trim());
    send({ type: 'text_input', text: text.trim() });
  } catch {
    hideGhost();
    setStatus('Transcription failed', 'error');
  }
}

function showGhost(text) {
  const row = document.getElementById('ghost-row');
  document.getElementById('ghost-text').textContent = text;
  row.classList.remove('hidden');
  // Hide after response starts
  setTimeout(hideGhost, 4000);
}
function hideGhost() {
  document.getElementById('ghost-row').classList.add('hidden');
}

// ── Audio playback ─────────────────────────────────────
function enqueueAudio(base64wav) {
  audioQueue.push(base64wav);
  if (!isPlaying) playNext();
}

async function playNext() {
  if (!audioQueue.length) { isPlaying = false; return; }
  isPlaying = true;
  const b64 = audioQueue.shift();
  try {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const ctx   = new AudioContext();
    const buf   = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const src   = ctx.createBufferSource();
    src.buffer  = buf;
    src.connect(ctx.destination);
    src.onended = () => { ctx.close(); playNext(); };
    src.start();
  } catch {
    playNext();
  }
}

// ── Session sidebar ────────────────────────────────────
const SPARKLINE_GREEN  = 'M0,20 8,17 18,21 28,13 40,15 54,10 68,14 82,9 96,12 110,9 120,10';
const SPARKLINE_PURPLE = 'M0,22 10,19 22,24 34,14 46,18 58,12 70,16 84,10 96,14 108,11 120,13';

function addSessionCard(title, id, sparkColor) {
  const list = document.getElementById('session-list');
  const mins = 0;

  const card = document.createElement('div');
  card.className = 'session-card active';
  card.dataset.id = id;

  const color = sparkColor || (Math.random() > .5 ? '#22c55e' : '#a855f7');
  const path  = color === '#22c55e' ? SPARKLINE_GREEN : SPARKLINE_PURPLE;

  card.innerHTML = `
    <div class="sc-top">
      <span class="sc-title">${escHtml(title)}</span>
      <span class="sc-age">now</span>
    </div>
    <div class="sparkline">
      <svg viewBox="0 0 120 30" preserveAspectRatio="none">
        <polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="sc-foot">
      <button class="sc-icon-btn" title="Voice"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3zm5.5 9a.5.5 0 0 1 .5.5A6 6 0 0 1 12.5 16v2H15a.5.5 0 0 1 0 1H9a.5.5 0 0 1 0-1h2.5v-2A6 6 0 0 1 6 10.5a.5.5 0 0 1 1 0 5 5 0 0 0 10 0 .5.5 0 0 1 .5-.5z"/></svg></button>
      <button class="sc-icon-btn" title="Transcript"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg></button>
    </div>`;

  // Mark previous cards inactive
  list.querySelectorAll('.session-card').forEach(c => c.classList.remove('active'));
  list.prepend(card);
  sessions.push({ id, title });
}

function seedSessions() {
  // Static example sessions so sidebar isn't empty on load
  const examples = [
    { title: 'Project Alpha Sync', age: '14m', color: '#22c55e', path: SPARKLINE_GREEN },
    { title: 'Competitive Analysis', age: '8m',  color: '#a855f7', path: SPARKLINE_PURPLE },
  ];
  const list = document.getElementById('session-list');
  examples.forEach(({ title, age, color, path }) => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="sc-top">
        <span class="sc-title">${escHtml(title)}</span>
        <span class="sc-age">- ${age}</span>
      </div>
      <div class="sparkline">
        <svg viewBox="0 0 120 30" preserveAspectRatio="none">
          <polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="sc-foot">
        <button class="sc-icon-btn" title="Voice">🎤</button>
        <button class="sc-icon-btn" title="Transcript">⊡</button>
      </div>`;
    list.appendChild(card);
  });
}

// ── Toggle panels ──────────────────────────────────────
function toggleInspector() {
  document.getElementById('inspector').classList.toggle('open');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ── Mobile tabs ────────────────────────────────────────
function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', ['canvas','sidebar','inspector'][i] === tab);
  });
  document.getElementById('sidebar').classList.toggle('open', tab === 'sidebar');
  document.getElementById('inspector').classList.toggle('open', tab === 'inspector');
  // canvas is always base layer
}

// ── Helpers ────────────────────────────────────────────
function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Init ───────────────────────────────────────────────
document.getElementById('new-conv-btn').addEventListener('click', () => {
  send({ type: 'new_conversation' });
});
document.getElementById('rail-new-btn')?.addEventListener('click', () => {
  send({ type: 'new_conversation' });
});

seedSessions();
connect();

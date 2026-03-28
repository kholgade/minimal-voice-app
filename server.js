require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(require('os').tmpdir(), 'voice-agent');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });
const sessions = new Map(); // sessionId -> message history

app.use(express.json());
app.use(express.static('public'));

// --- Config API ---

app.get('/api/config', (req, res) => {
  const envFile = path.join(__dirname, '.env');
  const config = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1 || line.startsWith('#')) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim();
      if (key) config[key] = val;
    }
  }
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const envFile = path.join(__dirname, '.env');
  const lines = Object.entries(req.body).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(envFile, lines + '\n');
  res.json({ ok: true, message: 'Saved. Restart server for changes to take effect.' });
});

// --- STT: audio upload -> transcript ---

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  try {
    const response = await axios.post(
      `${process.env.STT_URL || 'http://localhost:3001'}/transcribe`,
      { audio_path: req.file.path }
    );
    fs.unlink(req.file.path, () => {});
    res.json({ text: response.data.text || '' });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

// --- Recording API ---

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

app.post('/api/recording/start', (req, res) => {
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const meta = { sessionId, startTime: new Date().toISOString(), status: 'recording', chunks: [] };
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));
  res.json({ sessionId });
});

app.post('/api/recording/chunk', upload.single('audio'), async (req, res) => {
  const { sessionId, chunkIndex, chunkStart } = req.body;
  if (!req.file || !sessionId) return res.status(400).json({ error: 'Missing audio or sessionId' });

  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Session not found' });
  }

  const idx    = parseInt(chunkIndex) || 0;
  const start  = parseFloat(chunkStart) || 0;
  const ext    = req.file.mimetype.includes('ogg') ? 'ogg' : 'webm';
  const name   = `chunk-${String(idx).padStart(3, '0')}`;
  const audioPath = path.join(sessionDir, `${name}.${ext}`);
  fs.renameSync(req.file.path, audioPath);

  let segments = [];
  try {
    const r = await axios.post(
      `${process.env.STT_URL || 'http://localhost:3001'}/transcribe-meeting`,
      { audio_path: audioPath, chunk_start: start }
    );
    segments = r.data.segments || [];
  } catch (err) {
    console.error('Meeting STT error:', err.message);
  }

  fs.writeFileSync(
    path.join(sessionDir, `${name}.json`),
    JSON.stringify({ chunkIndex: idx, chunkStart: start, segments }, null, 2)
  );

  const metaPath = path.join(sessionDir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.chunks.push({ chunkIndex: idx, name, chunkStart: start });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  res.json({ segments });
});

app.post('/api/recording/stop', (req, res) => {
  const { sessionId } = req.body;
  const sessionDir = path.join(RECORDINGS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' });

  const metaPath = path.join(sessionDir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  const allSegments = [];
  for (const chunk of [...meta.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    const f = path.join(sessionDir, `${chunk.name}.json`);
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      allSegments.push(...(d.segments || []));
    }
  }

  const fullText = allSegments.map(s => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
  meta.status  = 'complete';
  meta.endTime = new Date().toISOString();
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'transcript.json'), JSON.stringify({ segments: allSegments, fullText }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'transcript.txt'), fullText);

  res.json({ sessionId, segments: allSegments, fullText });
});

app.get('/api/recording/sessions', (req, res) => {
  if (!fs.existsSync(RECORDINGS_DIR)) return res.json({ sessions: [] });
  const sessions = fs.readdirSync(RECORDINGS_DIR)
    .filter(d => fs.statSync(path.join(RECORDINGS_DIR, d)).isDirectory())
    .map(d => {
      const mp = path.join(RECORDINGS_DIR, d, 'meta.json');
      return fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : null;
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  res.json({ sessions });
});

app.get('/api/recording/:id', (req, res) => {
  const sessionDir = path.join(RECORDINGS_DIR, req.params.id);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Not found' });
  const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8'));
  const tp   = path.join(sessionDir, 'transcript.json');
  const transcript = fs.existsSync(tp) ? JSON.parse(fs.readFileSync(tp, 'utf8')) : null;
  res.json({ ...meta, transcript });
});

// --- WebSocket: text input -> LLM -> TTS ---

wss.on('connection', (ws) => {
  const sessionId = Date.now().toString() + Math.random().toString(36).slice(2);
  sessions.set(sessionId, []);
  ws.send(JSON.stringify({ type: 'session', id: sessionId }));

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'new_conversation') {
      sessions.set(sessionId, []);
      ws.send(JSON.stringify({ type: 'conversation_cleared' }));
      return;
    }

    if (msg.type === 'text_input' && msg.text?.trim()) {
      await handleInput(ws, sessionId, msg.text.trim());
    }
  });

  ws.on('close', () => sessions.delete(sessionId));
});

async function handleInput(ws, sessionId, userText) {
  const history = sessions.get(sessionId) || [];
  ws.send(JSON.stringify({ type: 'user_text', text: userText }));
  ws.send(JSON.stringify({ type: 'status', state: 'thinking' }));

  const messages = [
    { role: 'system', content: 'You are a helpful voice assistant. Be concise.' },
    ...history, // already trimmed to last 10 turns
    { role: 'user', content: userText },
  ];

  try {
    let fullResponse = '';
    let sentenceBuffer = '';

    ws.send(JSON.stringify({ type: 'status', state: 'responding' }));

    for await (const chunk of streamLLM(messages)) {
      fullResponse += chunk;
      sentenceBuffer += chunk;
      ws.send(JSON.stringify({ type: 'llm_chunk', text: chunk }));

      // Flush complete sentences to TTS
      const match = sentenceBuffer.match(/^([\s\S]*[.!?])\s*/);
      if (match) {
        const sentence = match[1].trim();
        sentenceBuffer = sentenceBuffer.slice(match[0].length);
        if (sentence) await sendTTS(ws, sentence);
      }
    }

    // Flush remainder
    if (sentenceBuffer.trim()) await sendTTS(ws, sentenceBuffer.trim());

    // Update history, keep last 10 turns (20 messages)
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: fullResponse });
    while (history.length > 20) history.shift();
    sessions.set(sessionId, history);

    ws.send(JSON.stringify({ type: 'response_done' }));
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.send(JSON.stringify({ type: 'status', state: 'idle' }));
  }
}

async function* streamLLM(messages) {
  const provider = process.env.LLM_PROVIDER || 'openai';
  const model = process.env.LLM_MODEL || 'gpt-4o';
  const temperature = parseFloat(process.env.TEMPERATURE || '0.7');
  const topP = parseFloat(process.env.TOP_P || '0.9');
  const maxTokens = parseInt(process.env.MAX_TOKENS || '1024');

  if (provider === 'ollama') {
    const resp = await axios.post(
      `${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`,
      { model, messages, stream: true, options: { temperature, top_p: topP } },
      { responseType: 'stream' }
    );
    let buf = '';
    for await (const chunk of resp.data) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content) yield obj.message.content;
        } catch {}
      }
    }

  } else if (provider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = messages.filter(m => m.role !== 'system');
    const resp = await axios.post(
      `${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`,
      {
        model,
        max_tokens: maxTokens,
        system: systemMsg,
        messages: userMessages,
        stream: true,
        temperature,
        top_p: topP,
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        responseType: 'stream',
      }
    );
    let buf = '';
    for await (const chunk of resp.data) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          if (obj.type === 'content_block_delta' && obj.delta?.text) yield obj.delta.text;
        } catch {}
      }
    }

  } else if (provider === 'google') {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body = {
      contents,
      generationConfig: { temperature, topP, maxOutputTokens: maxTokens },
    };
    if (systemMsg) body.system_instruction = { parts: [{ text: systemMsg }] };
    const resp = await axios.post(
      `${process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_API_KEY || ''}`,
      body,
      { responseType: 'stream' }
    );
    let buf = '';
    for await (const chunk of resp.data) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch {}
      }
    }

  } else {
    // OpenAI-compatible (default)
    const resp = await axios.post(
      `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`,
      { model, messages, stream: true, temperature, top_p: topP, max_tokens: maxTokens },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}` },
        responseType: 'stream',
      }
    );
    let buf = '';
    for await (const chunk of resp.data) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          const content = obj.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {}
      }
    }
  }
}

async function sendTTS(ws, text) {
  try {
    const resp = await axios.post(
      `${process.env.TTS_URL || 'http://localhost:3002'}/synthesize`,
      { text, voice: process.env.TTS_VOICE || 'af_bella' },
      { responseType: 'arraybuffer' }
    );
    const audio = Buffer.from(resp.data).toString('base64');
    ws.send(JSON.stringify({ type: 'audio_chunk', audio }));
  } catch (err) {
    console.error('TTS error:', err.message);
  }
}

server.listen(PORT, () => console.log(`Voice Agent running at http://localhost:${PORT}`));

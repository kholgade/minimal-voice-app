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
  const provider = process.env.LLM_PROVIDER || 'ollama';
  const model = process.env.LLM_MODEL || 'mistral';
  const temperature = parseFloat(process.env.TEMPERATURE || '0.7');
  const topP = parseFloat(process.env.TOP_P || '0.9');

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
  } else {
    // OpenAI-compatible
    const resp = await axios.post(
      `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`,
      { model, messages, stream: true, temperature, top_p: topP },
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

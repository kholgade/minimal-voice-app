# Voice Agent

A local voice assistant with meeting recording and transcription.

---

## Conversation

Talk or type with an AI assistant. Supports voice input and spoken responses.

- **Voice input** — click the mic button, speak, and it auto-submits after 2 seconds of silence
- **Text input** — type and press Enter or Send
- **Spoken responses** — the assistant's reply is read aloud sentence by sentence as it streams
- **Conversation history** — each session keeps the last 10 exchanges in context
- **New conversation** — start fresh with the + button; previous sessions appear in the History sidebar

### Intelligence Inspector

The right panel updates after each assistant response:
- **Key Summaries** — bullet points extracted from the response
- **Action Items** — checklist of tasks mentioned in the conversation

---

## New Recording

A separate mode for recording and transcribing long-form audio (meetings, interviews, lectures).

- **Start/stop** — large red button; recording continues until you click stop
- **Automatic chunking** — audio is split at natural speech pauses (2 seconds of silence) rather than fixed time intervals, so no words are cut mid-sentence. Chunks are also capped at 50 MB
- **Live transcript** — each chunk is transcribed as it completes and appears in real time with timestamps (`[MM:SS]`)
- **Full transcript** — assembled automatically when you stop, combining all chunks into a single continuous transcript
- **Copy / Download** — export the full transcript as plain text
- **Past recordings** — sidebar lists all previous sessions; click any to reload its transcript

Recordings are stored locally under `recordings/{session-id}/`:
```
chunk-000.webm   chunk-000.json   ← audio + per-chunk transcript
chunk-001.webm   chunk-001.json
...
transcript.json                   ← full assembled transcript
transcript.txt                    ← plain text version
```

---

## LLM Providers

Switch providers from the config page (⚙):

| Provider | Models |
|---|---|
| **OpenAI** (default) | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo |
| **Anthropic** | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5 |
| **Google Gemini** | gemini-2.0-flash, gemini-1.5-pro |
| **Ollama** | any locally running model |

---

## Speech (fully local)

Both speech-to-text and text-to-speech run entirely on-device. No audio is sent to any external service.

**STT** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (OpenAI Whisper, int8 quantized)

| Model | Size | Speed | Accuracy |
|---|---|---|---|
| small | ~500 MB | ~3× realtime | good |
| **medium** | ~1.5 GB | ~1.5× realtime | **default** |
| large-v3 | ~3 GB | ~1× realtime | best |

Change the model from the config page. A STT service restart is required for the change to take effect.

**TTS** — [Kokoro](https://github.com/hexgrad/kokoro) with four voices selectable from the config page:
- Bella (Friendly)
- Alice (Professional)
- Emma (Energetic)
- Adam (Male)

---

## Config Page

Accessible via ⚙ in the top bar or `http://localhost:3000/config.html`.

| Setting | Description |
|---|---|
| Provider | LLM provider (OpenAI / Anthropic / Google / Ollama) |
| Model | Model name for the selected provider |
| API Key | Required for OpenAI, Anthropic, Google |
| Temperature | Randomness of responses (0 – 2) |
| Top P | Nucleus sampling threshold (0 – 1) |
| Max Tokens | Maximum response length |
| TTS Voice | Voice used for spoken responses |
| STT Model | Whisper model size (small / medium / large-v3) |

Settings are saved to `.env` and take effect on next server restart (STT/TTS changes require restarting those services).

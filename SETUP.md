# Setup, Configuration & Deployment

---

## Requirements

- Node.js 22+
- Python 3.11+
- espeak-ng (system package — required by TTS)

---

## Local Setup

```bash
./setup.sh       # Linux / macOS
.\setup.ps1      # Windows
```

The script:
1. Installs `espeak-ng` via the system package manager
2. Creates a Python virtual environment at `.venv/`
3. Installs all Python dependencies
4. Downloads the Whisper STT model (default: `medium`)
5. Downloads all Kokoro TTS voice models
6. Installs Node.js dependencies
7. Creates `.env` from `.env.example` if not already present

### Override Whisper model at setup time

```bash
WHISPER_MODEL=small ./setup.sh       # Linux / macOS
$env:WHISPER_MODEL="small"; .\setup.ps1  # Windows
```

---

## Running Locally

```bash
./start.sh       # Linux / macOS
.\start.ps1      # Windows
```

Starts three processes:
- Node.js server on port **3000** (main app + API)
- STT service on port **3001** (faster-whisper)
- TTS service on port **3002** (Kokoro)

Open `http://localhost:3000` in the browser.

---

## Configuration

Edit `.env` directly or use the config page at `http://localhost:3000/config.html`.

### LLM

| Key | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai` \| `anthropic` \| `google` \| `ollama` |
| `LLM_MODEL` | `gpt-4o` | Model name for the selected provider |
| `OPENAI_API_KEY` | — | Required when `LLM_PROVIDER=openai` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for OpenAI-compatible endpoints |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Override for proxy |
| `GOOGLE_API_KEY` | — | Required when `LLM_PROVIDER=google` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `TEMPERATURE` | `0.7` | 0 – 2 |
| `TOP_P` | `0.9` | 0 – 1 |
| `MAX_TOKENS` | `1024` | Maximum response length |

### Speech (local)

| Key | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `medium` | `small` \| `medium` \| `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` |
| `TTS_VOICE` | `af_bella` | `af_bella` \| `bf_alice` \| `bf_emma` \| `am_adam` |
| `TTS_VOICE` | — | Change takes effect immediately |

### Services

| Key | Default | Description |
|---|---|---|
| `PORT` | `3000` | Node.js server port |
| `STT_URL` | `http://localhost:3001` | STT service address |
| `TTS_URL` | `http://localhost:3002` | TTS service address |

> LLM and port changes take effect after restarting the Node server.
> Changing `WHISPER_MODEL` requires restarting the STT service.

---

## Container Deployment

Single container using Docker. All three services are managed inside by `supervisord`.

### Build and run

```bash
docker compose up --build
```

### Override Whisper model at build time

```bash
docker compose build --build-arg WHISPER_MODEL=small
docker compose up
```

Available values: `small` | `medium` (default) | `large-v3`

### Volumes

| Host path | Container path | Purpose |
|---|---|---|
| `./.env` | `/app/.env` | API keys and settings |
| `./recordings/` | `/app/recordings/` | Persist recordings across restarts |

### Ports

Only port **3000** is exposed. STT (3001) and TTS (3002) are internal to the container.

### Image size

The Whisper model is pre-downloaded during `docker build`. Expected image sizes:

| Model | Approx. image size |
|---|---|
| `small` | ~3 GB |
| `medium` | ~4.5 GB |
| `large-v3` | ~6 GB |

---

## Project Structure

```
server.js          Node.js app server (WebSocket, API endpoints)
stt.py             Speech-to-text service (faster-whisper, Flask)
tts.py             Text-to-speech service (Kokoro, Flask)
public/            Browser frontend
  index.html       Main chat UI
  recording.html   New Recording page
  app.js           Chat logic
  recording.js     Recording logic
  css/             Modular stylesheets
recordings/        Created at runtime — one folder per recording session
requirements.txt   Python dependencies
package.json       Node.js dependencies
.env.example       Reference for all environment variables
setup.sh / .ps1    One-time setup script
start.sh / .ps1    Start all three services
Dockerfile         Single-container image
supervisord.conf   Process manager config (used inside container)
docker-compose.yml Convenience wrapper for container build and run
```

# ── Stage: base ───────────────────────────────────────────────────────────────
FROM python:3.11-slim AS base

# System deps: Node.js 22, espeak-ng (required by Kokoro TTS)
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates espeak-ng \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Supervisor to manage all 3 processes in one container
RUN pip install --no-cache-dir supervisor

WORKDIR /app

# ── Python dependencies ───────────────────────────────────────────────────────
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# ── Node.js dependencies ──────────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Application source ────────────────────────────────────────────────────────
COPY . .

# ── Pre-download STT model ────────────────────────────────────────────────────
# WHISPER_MODEL build arg (default: medium). Override at build time:
#   docker build --build-arg WHISPER_MODEL=small .
ARG WHISPER_MODEL=medium
ENV WHISPER_MODEL=${WHISPER_MODEL}

RUN python3 -c "\
from faster_whisper import WhisperModel; \
import os; \
m = os.environ.get('WHISPER_MODEL', 'medium'); \
print(f'Downloading Whisper {m}...'); \
WhisperModel(m, device='cpu', compute_type='int8'); \
print('Done.')"

# ── Pre-download TTS voice models ─────────────────────────────────────────────
RUN python3 -c "\
from kokoro import KPipeline; \
print('Downloading Kokoro voices...'); \
pipe = KPipeline(lang_code='a'); \
voices = ['af_bella', 'bf_alice', 'bf_emma', 'am_adam']; \
[list(pipe('Hi.', voice=v)) for v in voices]; \
print('Done.')"

# ── Runtime ───────────────────────────────────────────────────────────────────
COPY supervisord.conf /etc/supervisord.conf

EXPOSE 8080

# recordings/ is expected to be a mounted volume for persistence
VOLUME ["/app/recordings"]

CMD ["supervisord", "-c", "/etc/supervisord.conf"]

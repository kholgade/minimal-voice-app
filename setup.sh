#!/usr/bin/env bash
set -e

echo "=== Voice Agent Setup ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── 1. System dependencies ────────────────────────────────────────────────────
echo ""
echo ">>> Checking system dependencies..."

install_espeak() {
  if command -v apt-get &>/dev/null; then
    echo "Installing espeak-ng via apt..."
    apt-get install -y espeak-ng 2>/dev/null || sudo apt-get install -y espeak-ng
  elif command -v brew &>/dev/null; then
    echo "Installing espeak via Homebrew..."
    brew install espeak
  elif command -v dnf &>/dev/null; then
    dnf install -y espeak-ng 2>/dev/null || sudo dnf install -y espeak-ng
  else
    echo "WARNING: Could not auto-install espeak-ng. Install it manually for TTS to work."
    echo "  Ubuntu/Debian: sudo apt-get install espeak-ng"
    echo "  macOS:         brew install espeak"
  fi
}

if ! command -v espeak-ng &>/dev/null && ! command -v espeak &>/dev/null; then
  install_espeak
else
  echo "espeak-ng: OK"
fi

# ── 2. Python virtual environment ─────────────────────────────────────────────
echo ""
echo ">>> Setting up Python virtual environment..."
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
  echo "Created .venv"
else
  echo ".venv already exists"
fi
source "$VENV_DIR/bin/activate"

echo ">>> Installing Python dependencies..."
pip install --upgrade pip -q
pip install -r requirements.txt

# ── 3. Pre-download Whisper model ──────────────────────────────────────────────
echo ""
echo ">>> Pre-downloading Whisper STT model..."
# Default: medium — high accuracy at reasonable CPU speed (~1.5 GB)
# Options: small | medium | large-v3
WHISPER_MODEL="${WHISPER_MODEL:-medium}"
echo "  Model: $WHISPER_MODEL  (override with: WHISPER_MODEL=small ./setup.sh)"
python3 - <<PYEOF
import os
from faster_whisper import WhisperModel
model_name = os.environ.get('WHISPER_MODEL', 'medium')
print(f'  Downloading Whisper "{model_name}" model (CPU/int8)...')
WhisperModel(model_name, device='cpu', compute_type='int8')
print(f'  Whisper "{model_name}" model ready.')
PYEOF

# ── 4. Pre-download Kokoro TTS models ─────────────────────────────────────────
echo ""
echo ">>> Pre-downloading Kokoro TTS voice models..."
python3 - <<PYEOF
import io, numpy as np
from kokoro import KPipeline
import soundfile as sf

print('  Initializing Kokoro pipeline...')
pipe = KPipeline(lang_code='a')

voices = ['af_bella', 'bf_alice', 'bf_emma', 'am_adam']
for voice in voices:
    try:
        chunks = [a for _, _, a in pipe('Hi.', voice=voice) if a is not None and len(a) > 0]
        print(f'  Voice "{voice}": ready')
    except Exception as e:
        print(f'  Voice "{voice}": warning — {e}')

print('  Kokoro models ready.')
PYEOF

# ── 5. Node.js dependencies ────────────────────────────────────────────────────
echo ""
echo ">>> Installing Node.js dependencies..."
npm install

# ── 6. Environment file ────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo ""
  echo "Created .env from .env.example"
  echo "Add your API key to .env or use the config UI at http://localhost:3000/config.html"
fi

echo ""
echo "=== Setup complete ==="
echo "Run ./start.sh to start Voice Agent at http://localhost:3000"

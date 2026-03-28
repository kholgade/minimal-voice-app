#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Use venv python if available
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
if [ -f "$VENV_PYTHON" ]; then
  PYTHON="$VENV_PYTHON"
else
  PYTHON="python3"
fi

echo "Starting STT service (port 3001)..."
STT_PORT=3001 "$PYTHON" stt.py &
STT_PID=$!

echo "Starting TTS service (port 3002)..."
TTS_PORT=3002 "$PYTHON" tts.py &
TTS_PID=$!

echo "Starting Node server (port 3000)..."
node server.js &
SERVER_PID=$!

echo ""
echo "Voice Agent running at http://localhost:3000"
echo "Press Ctrl+C to stop all services."

trap "echo ''; echo 'Stopping...'; kill $STT_PID $TTS_PID $SERVER_PID 2>/dev/null; exit" INT TERM
wait

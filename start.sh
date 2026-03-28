#!/usr/bin/env bash
set -e

echo "Starting STT service (port 3001)..."
STT_PORT=3001 python stt.py &
STT_PID=$!

echo "Starting TTS service (port 3002)..."
TTS_PORT=3002 python tts.py &
TTS_PID=$!

echo "Starting server (port 3000)..."
node server.js &
SERVER_PID=$!

echo ""
echo "Voice Agent running at http://localhost:3000"
echo "Press Ctrl+C to stop."

trap "kill $STT_PID $TTS_PID $SERVER_PID 2>/dev/null; exit" INT TERM
wait

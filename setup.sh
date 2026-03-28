#!/usr/bin/env bash
set -e

echo "=== Voice Agent Setup ==="

# Copy .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it before starting."
fi

echo "Installing Node dependencies..."
npm install

echo "Installing Python dependencies..."
pip install -r requirements.txt

echo ""
echo "Setup complete. Run ./start.sh to start the app."

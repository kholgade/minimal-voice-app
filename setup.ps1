# setup.ps1 — Windows setup
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== Voice Agent Setup ==="

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example — edit it before starting."
}

Write-Host "Installing Node dependencies..."
npm install

Write-Host "Installing Python dependencies..."
pip install -r requirements.txt

Write-Host ""
Write-Host "Setup complete. Run .\start.ps1 to start the app."

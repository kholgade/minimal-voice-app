# setup.ps1 — Windows setup
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== Voice Agent Setup ===" -ForegroundColor Cyan
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ── 1. System dependencies ────────────────────────────────────────────────────
Write-Host "`n>>> Checking system dependencies..."
if (-not (Get-Command espeak-ng -ErrorAction SilentlyContinue) -and
    -not (Get-Command espeak   -ErrorAction SilentlyContinue)) {
  Write-Host "WARNING: espeak-ng not found." -ForegroundColor Yellow
  Write-Host "  Install it for TTS to work:"
  Write-Host "    winget install -e --id eSpeak.eSpeak"
  Write-Host "    or download from: https://github.com/espeak-ng/espeak-ng/releases"
} else {
  Write-Host "espeak-ng: OK"
}

# ── 2. Python virtual environment ─────────────────────────────────────────────
Write-Host "`n>>> Setting up Python virtual environment..."
$VenvDir = Join-Path $ScriptDir ".venv"
if (-not (Test-Path $VenvDir)) {
  python -m venv $VenvDir
  Write-Host "Created .venv"
} else {
  Write-Host ".venv already exists"
}
$PythonExe = Join-Path $VenvDir "Scripts\python.exe"
$PipExe    = Join-Path $VenvDir "Scripts\pip.exe"

Write-Host ">>> Installing Python dependencies..."
& $PipExe install --upgrade pip -q
& $PipExe install -r requirements.txt

# ── 3. Pre-download Whisper model ──────────────────────────────────────────────
Write-Host "`n>>> Pre-downloading Whisper STT model..."
# Default: medium — high accuracy at reasonable CPU speed (~1.5 GB)
# Override: $env:WHISPER_MODEL = "small"; .\setup.ps1
if (-not $env:WHISPER_MODEL) { $env:WHISPER_MODEL = "medium" }
Write-Host "  Model: $($env:WHISPER_MODEL)  (options: small | medium | large-v3)"
$whisperScript = @"
import os
from faster_whisper import WhisperModel
model_name = os.environ.get('WHISPER_MODEL', 'medium')
print(f'  Downloading Whisper "{model_name}" model (CPU/int8)...')
WhisperModel(model_name, device='cpu', compute_type='int8')
print(f'  Whisper "{model_name}" model ready.')
"@
& $PythonExe -c $whisperScript

# ── 4. Pre-download Kokoro TTS models ─────────────────────────────────────────
Write-Host "`n>>> Pre-downloading Kokoro TTS voice models..."
$kokoroScript = @"
from kokoro import KPipeline
print('  Initializing Kokoro pipeline...')
pipe = KPipeline(lang_code='a')
voices = ['af_bella', 'bf_alice', 'bf_emma', 'am_adam']
for voice in voices:
    try:
        chunks = [a for _, _, a in pipe('Hi.', voice=voice) if a is not None and len(a) > 0]
        print(f'  Voice "{voice}": ready')
    except Exception as e:
        print(f'  Voice "{voice}": warning - {e}')
print('  Kokoro models ready.')
"@
& $PythonExe -c $kokoroScript

# ── 5. Node.js dependencies ────────────────────────────────────────────────────
Write-Host "`n>>> Installing Node.js dependencies..."
npm install

# ── 6. Environment file ────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "`nCreated .env from .env.example"
  Write-Host "Add your API key to .env or use the config UI at http://localhost:3000/config.html"
}

Write-Host "`n=== Setup complete ===" -ForegroundColor Green
Write-Host "Run .\start.ps1 to start Voice Agent at http://localhost:3000"

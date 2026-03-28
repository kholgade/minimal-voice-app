# start.ps1 — Windows start
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Use venv python if available
$VenvPython = Join-Path $ScriptDir ".venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
  $PythonExe = $VenvPython
} else {
  $PythonExe = "python"
}

Write-Host "Starting STT service (port 3001)..."
$stt = Start-Process $PythonExe -ArgumentList "stt.py" `
  -Environment @{ STT_PORT = "3001" } -PassThru -NoNewWindow

Write-Host "Starting TTS service (port 3002)..."
$tts = Start-Process $PythonExe -ArgumentList "tts.py" `
  -Environment @{ TTS_PORT = "3002" } -PassThru -NoNewWindow

Write-Host "Starting Node server (port 3000)..."
$srv = Start-Process node -ArgumentList "server.js" -PassThru -NoNewWindow

Write-Host ""
Write-Host "Voice Agent running at http://localhost:3000"
Write-Host "Press Ctrl+C to stop all services."

try {
  Wait-Process -Id $srv.Id
} finally {
  $stt, $tts, $srv | ForEach-Object { if (-not $_.HasExited) { $_.Kill() } }
}

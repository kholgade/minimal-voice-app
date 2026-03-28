# start.ps1 — Windows start
Set-StrictMode -Version Latest

Write-Host "Starting STT service (port 3001)..."
$stt = Start-Process python -ArgumentList "stt.py" -Environment @{ STT_PORT = "3001" } -PassThru -NoNewWindow

Write-Host "Starting TTS service (port 3002)..."
$tts = Start-Process python -ArgumentList "tts.py" -Environment @{ TTS_PORT = "3002" } -PassThru -NoNewWindow

Write-Host "Starting server (port 3000)..."
$srv = Start-Process node -ArgumentList "server.js" -PassThru -NoNewWindow

Write-Host ""
Write-Host "Voice Agent running at http://localhost:3000"
Write-Host "Press Ctrl+C to stop."

try {
    Wait-Process -Id $srv.Id
} finally {
    $stt, $tts, $srv | ForEach-Object { if (-not $_.HasExited) { $_.Kill() } }
}

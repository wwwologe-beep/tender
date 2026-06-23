# dev-ngrok.ps1 — start ngrok + register Telegram webhook
param([int]$Port = 3000)

Write-Host "Starting ngrok on port $Port..." -ForegroundColor Green

$ngrokJob = Start-Job -ScriptBlock { param($p); & ngrok http $p } -ArgumentList $Port

Start-Sleep -Seconds 4

$tunnels = $null
for ($i = 0; $i -lt 10; $i++) {
    try {
        $tunnels = Invoke-RestMethod http://localhost:4040/api/tunnels -ErrorAction Stop
        if ($tunnels.tunnels.Count -gt 0) { break }
    } catch {}
    Start-Sleep -Seconds 1
}

if (-not $tunnels -or $tunnels.tunnels.Count -eq 0) {
    Write-Host "ERROR: Could not get ngrok URL" -ForegroundColor Red
    Stop-Job $ngrokJob; Remove-Job $ngrokJob
    exit 1
}

$httpsUrl = ($tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1).public_url
if (-not $httpsUrl) { $httpsUrl = $tunnels.tunnels[0].public_url }

Write-Host "ngrok URL: $httpsUrl" -ForegroundColor Cyan

$envFile = Join-Path $PSScriptRoot "../.env.local"
$envContent = Get-Content $envFile -Raw

$tokenMatch  = [regex]::Match($envContent, 'TELEGRAM_BOT_TOKEN=(.+)')
$secretMatch = [regex]::Match($envContent, 'TELEGRAM_SECRET_TOKEN=(.+)')
$token  = $tokenMatch.Groups[1].Value.Trim()
$secret = $secretMatch.Groups[1].Value.Trim()

$webhookUrl = "$httpsUrl/api/telegram/webhook"
Write-Host "Registering webhook: $webhookUrl" -ForegroundColor Yellow

$body = "{`"url`":`"$webhookUrl`",`"secret_token`":`"$secret`"}"
$result = Invoke-RestMethod `
    -Uri "https://api.telegram.org/bot$token/setWebhook" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body

if ($result.ok) {
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host " OK  Webhook registered!" -ForegroundColor Green
    Write-Host " Site:    http://localhost:$Port" -ForegroundColor White
    Write-Host " ngrok:   $httpsUrl" -ForegroundColor White
    Write-Host " Webhook: $webhookUrl" -ForegroundColor White
    Write-Host " Inspect: http://localhost:4040" -ForegroundColor White
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host "Bot is live. Press Ctrl+C to stop." -ForegroundColor Green
} else {
    Write-Host "ERROR registering webhook: $($result.description)" -ForegroundColor Red
}

Wait-Job $ngrokJob

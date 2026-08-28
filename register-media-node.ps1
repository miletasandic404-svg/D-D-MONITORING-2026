$ErrorActionPreference = "Stop"

Write-Host "=== D&D Monitoring: Media Node Registration ===" -ForegroundColor Cyan

$jwt = Read-Host "Enter platform_admin JWT" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($jwt)
$jwtPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if ([string]::IsNullOrWhiteSpace($jwtPlain)) {
    Write-Host "ERROR: JWT is required." -ForegroundColor Red; exit 1
}

$api = "https://www.dnd-monitoring.com"
$H = @{ "Authorization" = "Bearer $jwtPlain"; "Content-Type" = "application/json" }

Write-Host "`n[1/4] Checking for existing node..." -ForegroundColor Yellow
$existing = Invoke-RestMethod -Uri "$api/api/media-nodes" -Headers $H -Method GET -TimeoutSec 15
$found = $existing.nodes | Where-Object { $_.hostname -eq "dnd-media-server" }
if ($found) {
    Write-Host "STOP: Node already exists (ID: $($found.id))" -ForegroundColor Red
    exit 0
}
Write-Host "No existing node found." -ForegroundColor Green

Write-Host "[2/4] Registering media node..." -ForegroundColor Yellow
$body = @{ region = "ams"; hostname = "dnd-media-server"; public_hls_url = "https://dnd-media-server.fly.dev"; capacity = 50 } | ConvertTo-Json
$response = Invoke-RestMethod -Uri "$api/api/media-nodes" -Headers $H -Method POST -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15

$nodeId = $response.node.id
$heartbeatSecret = $response.heartbeat_secret

Write-Host "Registration successful!" -ForegroundColor Green
Write-Host "  node.id: $nodeId" -ForegroundColor Green

Write-Host "[3/4] Verifying record..." -ForegroundColor Yellow
$verify = Invoke-RestMethod -Uri "$api/api/media-nodes" -Headers $H -Method GET -TimeoutSec 15
$match = $verify.nodes | Where-Object { $_.id -eq $nodeId }
if (-not $match) { Write-Host "ERROR: Record not found after creation" -ForegroundColor Red; exit 1 }
Write-Host "Verified: Record exists (hostname: $($match.hostname))" -ForegroundColor Green

Write-Host "[4/4] Setting Fly secrets..." -ForegroundColor Yellow
$env:MEDIA_NODE_ID = $nodeId
$env:MEDIA_NODE_HEARTBEAT_SECRET = $heartbeatSecret
$env:API_BASE_URL = "https://www.dnd-monitoring.com/api"

& fly secrets set MEDIA_NODE_ID="$nodeId" MEDIA_NODE_HEARTBEAT_SECRET="$heartbeatSecret" API_BASE_URL="https://www.dnd-monitoring.com/api" -a dnd-media-server
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: fly secrets set failed" -ForegroundColor Red; exit 1 }

Write-Host "`n=== Complete ===" -ForegroundColor Cyan
Write-Host "node.id: $nodeId" -ForegroundColor Green
Write-Host "MEDIA_NODE_ID: set" -ForegroundColor Green
Write-Host "MEDIA_NODE_HEARTBEAT_SECRET: set" -ForegroundColor Green
Write-Host "API_BASE_URL: set" -ForegroundColor Green

param(
    [string]$BaseUrl = "https://www.dnd-monitoring.com",
    [string]$ReportPath = ".\e2e-report-auth.json"
)

$ErrorActionPreference = "Continue"
$results = @()

function Add-Result {
    param(
        [string]$Name,
        [string]$Status,
        [string]$Details = ""
    )

    $script:results += [pscustomobject]@{
        Test   = $Name
        Status = $Status
        Details = $Details
    }

    Write-Host "[$Status] $Name $Details"
}

function Get-StatusCode {
    param($ErrorRecord)

    if ($ErrorRecord.Exception.Response) {
        try {
            return [int]$ErrorRecord.Exception.Response.StatusCode
        }
        catch {}
    }

    return $null
}

function Invoke-Test {
    param(
        [string]$Name,
        [string]$Path,
        [int[]]$Expected = @(200, 401, 403, 404, 405)
    )

    try {
        $response = Invoke-WebRequest `
            -Uri ($BaseUrl.TrimEnd("/") + $Path) `
            -Method GET `
            -WebSession $session `
            -UseBasicParsing `
            -ErrorAction Stop

        $code = [int]$response.StatusCode

        if ($Expected -contains $code) {
            Add-Result $Name "PASS" "HTTP $code"
        }
        else {
            Add-Result $Name "FAIL" "HTTP $code (unexpected)"
        }

        return $response
    }
    catch {
        $code = Get-StatusCode $_

        if ($null -ne $code -and ($Expected -contains $code)) {
            Add-Result $Name "PASS" "HTTP $code"
        }
        elseif ($null -ne $code) {
            Add-Result $Name "FAIL" "HTTP $code"
        }
        else {
            Add-Result $Name "FAIL" $_.Exception.Message
        }

        return $null
    }
}

Write-Host ""
Write-Host "==============================================="
Write-Host " D&D MONITORING - AUTHENTICATED READ-ONLY E2E"
Write-Host "==============================================="
Write-Host ""
Write-Host "Target: $BaseUrl"
Write-Host ""

# ------------------------------------------------
# 1. Ask for credentials
# ------------------------------------------------

$email = Read-Host "Admin email"
$password = Read-Host "Admin password" -AsSecureString

$plainPassword = [System.Net.NetworkCredential]::new("", $password).Password

# ------------------------------------------------
# 2. Create session
# ------------------------------------------------

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# ------------------------------------------------
# 3. Login
# ------------------------------------------------

Write-Host ""
Write-Host "Logging in..."

$loginBody = @{
    email    = $email
    password = $plainPassword
} | ConvertTo-Json

try {
    $loginResponse = Invoke-WebRequest `
        -Uri ($BaseUrl.TrimEnd("/") + "/api/auth/sign-in/email") `
        -Method POST `
        -ContentType "application/json" `
        -Body $loginBody `
        -WebSession $session `
        -UseBasicParsing `
        -ErrorAction Stop

    Add-Result "Admin login" "PASS" "HTTP $([int]$loginResponse.StatusCode)"
}
catch {
    $code = Get-StatusCode $_

    if ($null -ne $code) {
        Add-Result "Admin login" "FAIL" "HTTP $code"
    }
    else {
        Add-Result "Admin login" "FAIL" $_.Exception.Message
    }

    Write-Host ""
    Write-Host "LOGIN FAILED. Testing authenticated endpoints would be meaningless."
    exit 1
}

# Do not keep password in memory longer than necessary.
$plainPassword = $null

# ------------------------------------------------
# 4. Verify session
# ------------------------------------------------

try {
    $sessionResponse = Invoke-WebRequest `
        -Uri ($BaseUrl.TrimEnd("/") + "/api/auth/get-session") `
        -Method GET `
        -WebSession $session `
        -UseBasicParsing `
        -ErrorAction Stop

    Add-Result "Authenticated session" "PASS" "HTTP $([int]$sessionResponse.StatusCode)"
}
catch {
    $code = Get-StatusCode $_

    if ($null -ne $code) {
        Add-Result "Authenticated session" "FAIL" "HTTP $code"
    }
    else {
        Add-Result "Authenticated session" "FAIL" $_.Exception.Message
    }
}

# ------------------------------------------------
# 5. Authenticated endpoint matrix
# ------------------------------------------------

Invoke-Test `
    -Name "Authenticated cameras" `
    -Path "/api/cameras" `
    -Expected @(200)

Invoke-Test `
    -Name "Authenticated incidents" `
    -Path "/api/incidents" `
    -Expected @(200)

Invoke-Test `
    -Name "Authenticated recordings" `
    -Path "/api/recordings" `
    -Expected @(200)

Invoke-Test `
    -Name "Authenticated AI detections" `
    -Path "/api/ai-detections" `
    -Expected @(200)

Invoke-Test `
    -Name "Authenticated users" `
    -Path "/api/users" `
    -Expected @(200,403)

Invoke-Test `
    -Name "Authenticated media nodes" `
    -Path "/api/media-nodes" `
    -Expected @(200,403)

Invoke-Test `
    -Name "Authenticated payment status" `
    -Path "/api/payments/status" `
    -Expected @(200)

# ------------------------------------------------
# 6. Additional authenticated endpoints
# ------------------------------------------------

Invoke-Test `
    -Name "Authenticated onboarding status" `
    -Path "/api/onboarding/status" `
    -Expected @(200,403,404)

Invoke-Test `
    -Name "Authenticated operator assignments" `
    -Path "/api/operator-assignments" `
    -Expected @(200,403,404)

Invoke-Test `
    -Name "Authenticated operators" `
    -Path "/api/operators" `
    -Expected @(200,403,404)

# ------------------------------------------------
# 7. Security leakage check
# ------------------------------------------------

$leakPatterns = @(
    "rtsp_password",
    "rtsp_password_encrypted",
    "heartbeat_secret",
    '"password"',
    '"secret"'
)

$leakEndpoints = @(
    "/api/cameras",
    "/api/incidents",
    "/api/recordings",
    "/api/ai-detections",
    "/api/payments/status"
)

foreach ($path in $leakEndpoints) {

    try {
        $response = Invoke-WebRequest `
            -Uri ($BaseUrl.TrimEnd("/") + $path) `
            -Method GET `
            -WebSession $session `
            -UseBasicParsing `
            -ErrorAction Stop

        $body = $response.Content

        $found = @()

        foreach ($pattern in $leakPatterns) {
            if ($body -match [regex]::Escape($pattern)) {
                $found += $pattern
            }
        }

        if ($found.Count -eq 0) {
            Add-Result "Leakage check $path" "PASS" "No sensitive field names detected"
        }
        else {
            Add-Result "Leakage check $path" "FAIL" ("Possible sensitive fields: " + ($found -join ", "))
        }
    }
    catch {
        Add-Result "Leakage check $path" "INFO" "Endpoint unavailable"
    }
}

# ------------------------------------------------
# 8. Summary
# ------------------------------------------------

$pass = @($results | Where-Object Status -eq "PASS").Count
$fail = @($results | Where-Object Status -eq "FAIL").Count
$skip = @($results | Where-Object Status -eq "SKIP").Count
$info = @($results | Where-Object Status -eq "INFO").Count

$report = [pscustomobject]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    target    = $BaseUrl
    mode      = "AUTHENTICATED_READ_ONLY"
    summary   = @{
        pass = $pass
        fail = $fail
        skip = $skip
        info = $info
    }
    results = $results
}

$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $ReportPath

Write-Host ""
Write-Host "==============================================="
Write-Host "RESULT"
Write-Host "==============================================="
Write-Host "PASS: $pass"
Write-Host "FAIL: $fail"
Write-Host "SKIP: $skip"
Write-Host "INFO: $info"
Write-Host ""
Write-Host "Report: $ReportPath"

if ($fail -eq 0) {
    Write-Host ""
    Write-Host "VERDICT: AUTHENTICATED READ-ONLY CLEAN"
}
else {
    Write-Host ""
    Write-Host "VERDICT: ISSUES FOUND - REVIEW FAIL ITEMS"
}
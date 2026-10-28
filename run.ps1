[CmdletBinding()]
param(
    [int]$Port = 8000,
    [switch]$Reload,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Python = Join-Path $Root "venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    $Python = "python"
}

& $Python -c "import fastapi, uvicorn, pandas, sklearn, joblib" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing Python dependencies from requirements.txt..." -ForegroundColor Yellow
    & $Python -m pip install -r (Join-Path $Root "requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed."
    }
}

if (-not (Test-Path (Join-Path $Root "models\dq_audit_report.json"))) {
    Write-Host "Generating frozen ML artifacts and data-quality audit..." -ForegroundColor Yellow
    & $Python (Join-Path $Root "src\export_artifacts.py")
    if ($LASTEXITCODE -ne 0) {
        throw "Artifact export failed."
    }
}

$Url = "http://127.0.0.1:$Port"
Write-Host ""
Write-Host "TransitPulse AI is starting at $Url" -ForegroundColor Cyan
Write-Host "Evaluator view: $Url/?view=evaluator" -ForegroundColor DarkGray
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor DarkGray
Write-Host ""

$UvicornArgs = @(
    "-m", "uvicorn",
    "--app-dir", "src",
    "app:app",
    "--host", "127.0.0.1",
    "--port", $Port.ToString()
)
if ($Reload) {
    $UvicornArgs += "--reload"
}

$BrowserJob = $null
if (-not $NoBrowser) {
    $BrowserJob = Start-Job -ScriptBlock {
        param($Target)
        Start-Sleep -Seconds 2
        Start-Process $Target
    } -ArgumentList $Url
}

try {
    & $Python @UvicornArgs
} finally {
    if ($BrowserJob) {
        Remove-Job $BrowserJob -Force -ErrorAction SilentlyContinue
    }
}

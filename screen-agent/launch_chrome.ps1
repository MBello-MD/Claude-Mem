# Starts a separate Chrome for the agent: its own profile (no saved logins, no history from your normal
# Chrome) with the DevTools port open on this machine only. Your normal Chrome keeps running untouched.
#
#   powershell -ExecutionPolicy Bypass -File .\launch_chrome.ps1

$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error "chrome.exe not found. Edit `$candidates in this script."; exit 1 }

$profileDir = Join-Path $env:LOCALAPPDATA "screen-agent\chrome-profile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
    "--remote-debugging-port=9222",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$profileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,960",
    "about:blank"
)

Start-Sleep -Seconds 2
try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5
    Write-Host "Agent Chrome is up: $($v.Browser). Profile: $profileDir"
} catch {
    Write-Warning "Chrome started but the DevTools port did not answer. Close every window of the agent Chrome and run this again."
}

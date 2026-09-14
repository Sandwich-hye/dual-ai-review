$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$profileDir = Join-Path $projectRoot ".browser-profile"
$chromeCandidates = @(
  (Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:LocalAppData} "Google\Chrome\Application\chrome.exe")
)
$chromePath = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chromePath) { throw "Google Chrome was not found in the standard installation locations." }
if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
Write-Host "Starting dedicated Chrome profile: $profileDir"
Write-Host "CDP endpoint: http://127.0.0.1:9222"
& $chromePath `
  "--remote-debugging-port=9222" `
  "--remote-debugging-address=127.0.0.1" `
  "--user-data-dir=$profileDir" `
  "--new-window"
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot "data\logs"
$logFile = Join-Path $logDirectory "server.log"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Set-Location -LiteralPath $projectRoot

$env:SIVAN_PORT = "8766"
$nodeExecutable = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
}

$ErrorActionPreference = "Continue"
& $nodeExecutable "--no-warnings" "server.mjs" *>> $logFile
$nodeExitCode = $LASTEXITCODE
Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) Node process exited with code $nodeExitCode."
exit $nodeExitCode

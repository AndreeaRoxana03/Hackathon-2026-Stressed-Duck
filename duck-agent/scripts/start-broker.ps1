$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    & npm run build --workspace @stressed-duck/host
    if ($LASTEXITCODE -ne 0) { throw "Host build failed." }
    & node (Join-Path $projectRoot "packages\host\dist\cli.js") broker
    if ($LASTEXITCODE -ne 0) { throw "Broker exited with an error." }
} finally {
    Pop-Location
}
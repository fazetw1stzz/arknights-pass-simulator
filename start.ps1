$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PYTHONDONTWRITEBYTECODE = '1'
python -B (Join-Path $PSScriptRoot 'server.py') --open-browser

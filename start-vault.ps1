$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $python = @('py', '-3')
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $python = @('python')
} else {
    Write-Host ''
    Write-Host 'Python 3 was not found.' -ForegroundColor Red
    Write-Host 'Install it from https://www.python.org/downloads/windows/'
    Write-Host 'During setup, enable "Add python.exe to PATH", then run this script again.'
    exit 1
}

if (-not $env:PORT) { $env:PORT = '7777' }
$env:OPEN_BROWSER = '1'
Write-Host "Starting Tobyworld Lore Land Deed Viewer at http://127.0.0.1:$($env:PORT)/"
if ($env:OPENSEA_API_KEY) {
    Write-Host 'OpenSea API key: available'
} else {
    Write-Host 'OpenSea API key: not set; public-page artwork fallback will still be tried'
}

if ($python.Count -eq 2) {
    & $python[0] $python[1] 'serve-vault.py'
} else {
    & $python[0] 'serve-vault.py'
}
exit $LASTEXITCODE

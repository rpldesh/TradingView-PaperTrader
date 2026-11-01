# One-command launcher: installs dependencies on first run, builds the UI,
# and serves everything from FastAPI at http://localhost:8000
#   .\start.ps1          build + run
#   .\start.ps1 -Dev     backend with reload + Vite dev server (http://localhost:5173)
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$py = Join-Path $root 'backend\.venv\Scripts\python.exe'

if (-not (Test-Path $py)) {
    python -m venv (Join-Path $root 'backend\.venv')
    & $py -m pip install -r (Join-Path $root 'backend\requirements.txt')
}
Push-Location (Join-Path $root 'frontend')
if (-not (Test-Path 'node_modules')) { npm install }
if (-not $Dev) { npm run build }
Pop-Location

if ($Dev) {
    Start-Process powershell -ArgumentList '-NoExit', '-Command', "cd '$root\frontend'; npm run dev"
    Start-Process 'http://localhost:5173'
    Push-Location (Join-Path $root 'backend')
    & $py -m uvicorn app.main:app --port 8000 --reload
    Pop-Location
} else {
    Start-Process 'http://localhost:8000'
    Push-Location (Join-Path $root 'backend')
    & $py -m uvicorn app.main:app --port 8000
    Pop-Location
}

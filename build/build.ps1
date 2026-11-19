# Build FeatherWatch for Windows. Output: dist\FeatherWatch\FeatherWatch.exe and dist\FeatherWatch-win.zip
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File build\build.ps1
# Runtime needs Microsoft Edge WebView2 Runtime (preinstalled on Windows 11 / current Windows 10).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$root = (Get-Location).Path
$venvPy = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPy)) {
  if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 -m venv .venv }
  else { & python -m venv .venv }
  if ($LASTEXITCODE) { throw "venv creation failed" }
}
& $venvPy -m pip install --upgrade pip
if ($LASTEXITCODE) { throw "pip upgrade failed" }
& $venvPy -m pip install -r requirements-dev.txt
if ($LASTEXITCODE) { throw "pip install failed" }

& $venvPy -m PyInstaller --noconfirm --clean --distpath "$root\dist" --workpath "$root\.pyi-build" "$root\build\featherwatch.spec"
if ($LASTEXITCODE) { throw "PyInstaller failed" }

$zip = Join-Path $root "dist\FeatherWatch-win.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root "dist\FeatherWatch") -DestinationPath $zip
Write-Host "Done: dist\FeatherWatch\FeatherWatch.exe  (zip: dist\FeatherWatch-win.zip)"

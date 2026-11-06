<#
.SYNOPSIS
  Builds the Canvas Windows installer (canvas-xl3a.2): CanvasSetup-<version>.exe in packaging\windows\out.

.DESCRIPTION
  Run on Windows from a checkout where `npm ci` has been run (or pass -WebDist), with uv on PATH and
  Inno Setup 6 installed (or pass -SkipInstaller to stop after staging). Steps:
    1. a private Python: python-build-standalone's CPython (pinned below, sha256-checked), unpacked to stage\python
    2. the API's locked production dependencies installed into it (uv export --frozen --no-dev), without
       psycopg: an installed Canvas uses SQLite only
    3. apps\api-py\src and migrations copied to stage\app (the layout canvas_api.desktop and the migration runner
       expect), a VERSION file, and a .pth file so the private Python finds canvas_api
    4. the web app built for the same origin (relative API URLs, as in the container image) to stage\app\web
    5. LICENSE, THIRD-PARTY-NOTICES.md and the Python runtime's licence to stage\licenses
    6. Inno Setup compiles canvas.iss over the stage folder

.PARAMETER Version
  The version shown in Windows and written to VERSION (the launcher seeds the catalog again when it changes).
  Default: 0.0.0-dev.<commit>.

.PARAMETER WebDist
  An already-built apps\web\dist (built with VITE_API_BASE_URL set to an empty string) to use instead of building.

.PARAMETER SkipInstaller
  Stop after staging (no Inno Setup needed); stage\python\python.exe -m canvas_api.desktop start then runs Canvas.
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$WebDist,
  [string]$OutDir,
  [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower drawing its progress bar

# python-build-standalone release 20261021 (CPython 3.13.17), stripped install_only build for 64-bit Windows.
# A newer build: take the asset's sha256 from the release page (GitHub shows each asset's digest).
$PythonUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.13.17%2B20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
$PythonSha256 = '56cde3b1a1dcc36576753cb408ee0c3568d211baafa0eee40423adc147c480f2'

$Here = $PSScriptRoot
$Root = (Resolve-Path (Join-Path $Here '..\..')).ProviderPath
$Api = Join-Path $Root 'apps\api-py'
if (-not $OutDir) { $OutDir = Join-Path $Here 'out' }
$Stage = Join-Path $OutDir 'stage'
$Cache = Join-Path $OutDir 'cache'

function Invoke-Native {
  param([string]$What, [scriptblock]$Command)
  # Windows PowerShell 5.1 turns a native command's stderr output into an error, which Stop would throw on.
  $ErrorActionPreference = 'Continue'
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

if (-not $Version) {
  $ErrorActionPreference = 'Continue'
  $commit = (& git -C $Root rev-parse --short HEAD 2>$null)
  $ErrorActionPreference = 'Stop'
  if (-not $commit) { $commit = 'unknown' }
  $Version = "0.0.0-dev.$commit"
}
# Windows' file version must be four numbers: the leading x.y.z of the version, then 0.
$numbers = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)')
$FileVersion = if ($numbers.Success) { "$($numbers.Groups[1]).$($numbers.Groups[2]).$($numbers.Groups[3]).0" } else { '0.0.0.0' }
Write-Host "Building Canvas $Version"

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage, $Cache | Out-Null

# 1. The private Python.
$archive = Join-Path $Cache ([uri]::UnescapeDataString(($PythonUrl -split '/')[-1]))
if (-not (Test-Path $archive)) {
  Write-Host "Downloading $PythonUrl"
  Invoke-WebRequest -Uri $PythonUrl -OutFile "$archive.part" -UseBasicParsing
  Move-Item -Force "$archive.part" $archive
}
$actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
if ($actual -ne $PythonSha256) {
  Remove-Item -Force $archive
  throw "The Python download's sha256 is $actual, expected $PythonSha256."
}
Invoke-Native 'Unpacking Python' { tar -xzf $archive -C $Stage }  # makes stage\python
$Python = Join-Path $Stage 'python\python.exe'

# 2. The locked production dependencies, without psycopg (Postgres only).
$requirements = Join-Path $OutDir 'requirements.txt'
Invoke-Native 'uv export' {
  uv export --project $Api --frozen --no-dev --no-emit-project --no-emit-package psycopg `
    --no-emit-package psycopg-binary --format requirements.txt --output-file $requirements --quiet
}
Invoke-Native 'Installing the dependencies' {
  uv pip install --python $Python --break-system-packages --require-hashes --no-deps --compile-bytecode `
    --link-mode copy --quiet -r $requirements
}

# 3. The API, as apps\api-py lays it out (src\ next to migrations\).
$app = Join-Path $Stage 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($folder in 'src', 'migrations') {
  Invoke-Native "Copying $folder" {
    robocopy (Join-Path $Api $folder) (Join-Path $app $folder) /E /XD __pycache__ /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
    # robocopy: 0-7 are success codes.
    if ($LASTEXITCODE -lt 8) { $global:LASTEXITCODE = 0 }
  }
}
Set-Content -Path (Join-Path $app 'VERSION') -Value $Version -Encoding ascii -NoNewline
# site-packages is python\Lib\site-packages; a relative .pth line is read from there.
Set-Content -Path (Join-Path $Stage 'python\Lib\site-packages\canvas.pth') -Value '..\..\..\app\src' -Encoding ascii
Invoke-Native 'Compiling the API' { & $Python -m compileall -q (Join-Path $app 'src') }

# 4. The web app, with relative API URLs (same origin: the API serves it).
if (-not $WebDist) {
  Push-Location $Root
  try {
    Invoke-Native 'Building diagram-core' { npm run build --workspace=@canvas/diagram-core }
    # An empty VITE_API_BASE_URL can't be set from PowerShell 5.1 ($env:X = '' removes it), so node sets it.
    Invoke-Native 'Building the web app' {
      node -e "process.env.VITE_API_BASE_URL='';require('child_process').execSync('npm run build --workspace=@canvas/web',{stdio:'inherit'})"
    }
  } finally { Pop-Location }
  $WebDist = Join-Path $Root 'apps\web\dist'
}
if (-not (Test-Path (Join-Path $WebDist 'index.html'))) { throw "No index.html in $WebDist." }
Invoke-Native 'Copying the web app' {
  robocopy $WebDist (Join-Path $app 'web') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -lt 8) { $global:LASTEXITCODE = 0 }
}

# 5. Licences.
$licenses = Join-Path $Stage 'licenses'
New-Item -ItemType Directory -Force -Path $licenses | Out-Null
Copy-Item (Join-Path $Root 'LICENSE') (Join-Path $licenses 'LICENSE.txt')
Copy-Item (Join-Path $Root 'THIRD-PARTY-NOTICES.md') (Join-Path $licenses 'THIRD-PARTY-NOTICES.md')
Copy-Item (Join-Path $Stage 'python\LICENSE.txt') (Join-Path $licenses 'PYTHON-LICENSE.txt')

# The staged app must at least import (catches a broken .pth or a missing dependency before Inno Setup runs).
Invoke-Native 'Checking the staged app' {
  & $Python -I -c "import sys; sys.path.append(r'$app\src'); import canvas_api.desktop, canvas_api.app, uvicorn"
}
Invoke-Native 'Checking canvas_api is found through the .pth' {
  & $Python -c "import canvas_api.desktop as d; print('Staged', d.APP_ROOT, d.app_version(), d.web_dir())"
}

if ($SkipInstaller) {
  Write-Host "Staged in $Stage (no installer: -SkipInstaller)."
  return
}

# 6. The installer.
$iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $iscc = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) not found. Install it, or pass -SkipInstaller.' }
Invoke-Native 'Inno Setup' {
  & $iscc /Qp "/DAppVersion=$Version" "/DFileVersion=$FileVersion" "/DStageDir=$Stage" "/O$OutDir" (Join-Path $Here 'canvas.iss')
}
Write-Host "Built $(Join-Path $OutDir "CanvasSetup-$Version.exe")"

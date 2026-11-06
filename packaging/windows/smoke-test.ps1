<#
.SYNOPSIS
  Installs a built CanvasSetup-*.exe for the current user and checks it works (canvas-xl3a.3; CI runs it on
  windows-latest). Changes this user's Canvas install and %LOCALAPPDATA%\Canvas, so run it on a throwaway machine.

.DESCRIPTION
  Silent install; the first start creates the admin from first-admin.json and serves the web app; sign-in works;
  the Start-menu shortcuts exist; installing again over a running Canvas (an upgrade) stops it and keeps the data;
  stop; a silent uninstall removes the program and keeps the data.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\Canvas'
$DataDir = Join-Path $env:LOCALAPPDATA 'Canvas'
$Pythonw = Join-Path $AppDir 'python\pythonw.exe'
$Python = Join-Path $AppDir 'python\python.exe'
$Email = 'owner@example.com'
$Password = 'smoke-test-pass-2026'
$Logs = Join-Path (Split-Path $Installer) 'smoke-logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Check([bool]$Condition, [string]$What) {
  if (-not $Condition) { throw "FAILED: $What" }
  Write-Host "ok: $What"
}

# Runs Setup or the uninstaller silently, failing (not hanging) if it doesn't finish in 10 minutes.
function Run-Silently([string]$Program, [string]$LogName) {
  $log = Join-Path $Logs $LogName
  $process = Start-Process -FilePath $Program -PassThru -ArgumentList @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$log")
  if (-not $process.WaitForExit(600000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 20
    throw "FAILED: $LogName didn't finish within 10 minutes"
  }
  Check ($process.ExitCode -eq 0) "$LogName exited 0"
}

function Install([string]$LogName) { Run-Silently $Installer $LogName }

function Port { (Get-Content (Join-Path $DataDir 'canvas.pid') | ConvertFrom-Json).port }

function Healthy([int]$Port) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/health").StatusCode -eq 200 }
  catch { return $false }
}

function Start-Canvas {
  $started = Get-Date
  Start-Process -FilePath $Pythonw -WorkingDirectory $AppDir -ArgumentList '-m', 'canvas_api.desktop', 'start', '--no-browser'
  # The first start on a fresh machine is slow (seeding, and the virus scanner reading every new file).
  for ($i = 0; $i -lt 360; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Test-Path (Join-Path $DataDir 'canvas.pid')) -and (Healthy (Port))) {
      Write-Host "Canvas answered after $([int]((Get-Date) - $started).TotalSeconds) s"
      return
    }
  }
  Get-Content (Join-Path $DataDir 'logs\canvas.log') -ErrorAction SilentlyContinue | Select-Object -Last 40
  throw 'FAILED: Canvas did not start answering within 3 minutes'
}

function Sign-In {
  $body = @{ email = $Email; password = $Password } | ConvertTo-Json
  $response = Invoke-WebRequest -UseBasicParsing -Method Post -ContentType 'application/json' -Body $body `
    "http://127.0.0.1:$(Port)/auth/local/login"
  return ($response.Content | ConvertFrom-Json).user
}

try {
  if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }

  Install 'install.log'
  Check (Test-Path $Pythonw) 'the private Python is installed'
  Check (Test-Path (Join-Path $AppDir 'app\VERSION')) 'the VERSION file is installed'
  $menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Canvas'
  Check (Test-Path (Join-Path $menu 'Canvas.lnk')) 'Start menu: Canvas'
  Check (Test-Path (Join-Path $menu 'Stop Canvas.lnk')) 'Start menu: Stop Canvas'

  # What the wizard page writes on an interactive install.
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  @{ email = $Email; password = $Password } | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $DataDir 'first-admin.json')
  Start-Canvas
  Check (-not (Test-Path (Join-Path $DataDir 'first-admin.json'))) 'first-admin.json is deleted'
  $page = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$(Port)/"
  Check ($page.Content -match '<div id="root">') 'the web app is served'
  $user = Sign-In
  Check (($user.role -eq 'admin') -and $user.mustChangePassword) 'the first admin signs in with the temporary password'
  & $Python -m canvas_api.desktop status
  Check ($LASTEXITCODE -eq 0) 'status says Canvas is running'

  # An upgrade over the running Canvas.
  $port = Port
  Install 'upgrade.log'
  Check (-not (Healthy $port)) 'the upgrade stopped the running Canvas'
  Start-Canvas
  Check ((Sign-In).email -eq $Email) 'the account survived the upgrade'

  & $Python -m canvas_api.desktop stop
  & $Python -m canvas_api.desktop status
  Check ($LASTEXITCODE -eq 1) 'stop stopped Canvas'

  Run-Silently (Join-Path $AppDir 'unins000.exe') 'uninstall.log'
  # The uninstaller finishes removing itself just after it exits.
  for ($i = 0; $i -lt 20 -and (Test-Path $Pythonw); $i++) { Start-Sleep -Milliseconds 500 }
  Check (-not (Test-Path $Pythonw)) 'uninstall removed the program'
  Check (Test-Path (Join-Path $DataDir 'canvas.db')) 'uninstall kept the data'
  Write-Host 'Smoke test passed.'
} finally {
  if (Test-Path (Join-Path $DataDir 'logs')) { Copy-Item -Recurse -Force (Join-Path $DataDir 'logs') (Join-Path $Logs 'canvas') }
}

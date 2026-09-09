$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Candidates = @()
if ($env:MYNDA_MSYS2_ROOT) { $Candidates += $env:MYNDA_MSYS2_ROOT }
$Candidates += @('C:\msys64', 'C:\tools\msys64')
$MsysRoot = $Candidates | Where-Object { Test-Path (Join-Path $_ 'usr\bin\bash.exe') } | Select-Object -First 1

if (-not $MsysRoot) {
  throw @"
MSYS2 was not found. Install 64-bit MSYS2 from https://www.msys2.org/, open
its UCRT64 terminal once, update it, and retry. If it is installed elsewhere,
set MYNDA_MSYS2_ROOT to that directory.
"@
}

$env:CHERE_INVOKING = '1'
$env:MSYSTEM = 'UCRT64'
$env:MYNDA_PROJECT_ROOT_WINDOWS = $ProjectRoot
$Bash = Join-Path $MsysRoot 'usr\bin\bash.exe'
$Command = 'PROJECT_ROOT="$(cygpath -u "$MYNDA_PROJECT_ROOT_WINDOWS")"; exec bash "$PROJECT_ROOT/scripts/prepare-media-tools-windows-msys2.sh"'

& $Bash -lc $Command
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Candidates = @()
if ($env:MYNDA_MSYS2_ROOT) { $Candidates += $env:MYNDA_MSYS2_ROOT }
$Candidates += @('C:\msys64', 'C:\tools\msys64')
$MsysRoot = $Candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'usr\bin\bash.exe') -PathType Leaf } | Select-Object -First 1

if (-not $MsysRoot) {
  throw @"
MSYS2 was not found. Install 64-bit MSYS2 from https://www.msys2.org/, open
its UCRT64 terminal once, update it, and retry. If it is installed elsewhere,
set MYNDA_MSYS2_ROOT to that directory.
"@
}

$env:CHERE_INVOKING = '1'
$env:MSYSTEM = 'UCRT64'
# MSYS2's default login profile removes most of the Windows PATH, including
# Node. Keep the invoking PATH behind UCRT64's own compiler/build tools.
$env:MSYS2_PATH_TYPE = 'inherit'
$Bash = Join-Path $MsysRoot 'usr\bin\bash.exe'
$Cygpath = Join-Path $MsysRoot 'usr\bin\cygpath.exe'
$BuildScriptWindows = Join-Path $ProjectRoot 'scripts\prepare-media-tools-windows-msys2.sh'

# Windows PowerShell 5.1 changes embedded quotes in native command arguments.
# Convert the filename separately and pass it as data, never as bash -c source.
$BuildScript = & $Cygpath -u $BuildScriptWindows
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $BuildScript) { throw 'MSYS2 could not resolve the Windows media build script path.' }

& $Bash --login -- $BuildScript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

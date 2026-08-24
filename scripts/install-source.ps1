$ForceDependencyInstall = $false
$InstallerArguments = @()
foreach ($argument in $args) {
  if ($argument -eq "-ForceDependencyInstall" -or $argument -eq "--force-dependency-install") {
    $ForceDependencyInstall = $true
  } else {
    $InstallerArguments += $argument
  }
}

$ErrorActionPreference = "Stop"

function Assert-LastExitCode([string]$message) {
  if ($LASTEXITCODE -ne 0) { throw $message }
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -ne "x64") {
  throw "Windows source installation currently supports x64; detected $architecture."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 22.12+ LTS (recommended), 24.x, or 20.19+ LTS."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm.cmd was not found next to the active Node.js installation."
}

$nodeVersionText = & node -p "process.versions.node"
Assert-LastExitCode "Failed to read the active Node.js version."
$nodeVersion = [version]$nodeVersionText
$nodeSupported = ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -ge 19) -or
  ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12) -or
  ($nodeVersion.Major -eq 24)
if (-not $nodeSupported) {
  throw "Node.js $nodeVersionText is unsupported. Install Node.js 22.12+ LTS (recommended), 24.x, or 20.19+ LTS."
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "c2000-source-install-$([guid]::NewGuid().ToString('N'))"
$stagingPackage = Join-Path $stagingRoot "package"
$runtimeOut = Join-Path $stagingPackage "dist\src"
$previousRuntimeOut = $env:C2000_BUILD_RUNTIME_OUTDIR

Push-Location $repositoryRoot
try {
  $dependenciesReady = -not $ForceDependencyInstall
  if ($dependenciesReady) {
    & npm.cmd ls --depth=0 --silent *> $null
    $dependenciesReady = $LASTEXITCODE -eq 0
  }
  if ($dependenciesReady) {
    & node -e "require.resolve('typescript/package.json'); require.resolve('esbuild'); require.resolve('@modelcontextprotocol/sdk/server/mcp.js'); const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();" *> $null
    $dependenciesReady = $LASTEXITCODE -eq 0
  }
  if (-not $dependenciesReady) {
    Write-Host "Restoring dependencies from package-lock.json..."
    & npm.cmd ci
    Assert-LastExitCode "npm ci failed. Confirm the active Node version has a compatible better-sqlite3 binary or native build toolchain."
  } else {
    Write-Host "Dependencies are current; skipping npm ci."
  }

  New-Item -ItemType Directory -Path $stagingPackage | Out-Null
  $env:C2000_BUILD_RUNTIME_OUTDIR = $runtimeOut
  Write-Host "Building into isolated staging directory: $runtimeOut"
  & node scripts\build.mjs -p tsconfig.src.json
  Assert-LastExitCode "Isolated runtime build failed."

  New-Item -ItemType Directory -Path (Join-Path $stagingPackage "scripts") | Out-Null
  Copy-Item -LiteralPath package.json -Destination $stagingPackage
  Copy-Item -LiteralPath scripts\c2000-mcp-doctor.mjs -Destination (Join-Path $stagingPackage "scripts")
  Copy-Item -LiteralPath skills -Destination $stagingPackage -Recurse

  $setupEntrypoint = Join-Path $runtimeOut "installer\index.js"
  $setupArguments = @("install", "--workspace", $repositoryRoot) + @($InstallerArguments)
  & node $setupEntrypoint @setupArguments
  Assert-LastExitCode "C2000 Multicore MCP source installation failed."
} finally {
  $env:C2000_BUILD_RUNTIME_OUTDIR = $previousRuntimeOut
  Pop-Location
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}

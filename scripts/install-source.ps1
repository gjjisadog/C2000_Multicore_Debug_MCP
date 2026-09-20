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
  throw "Node.js was not found. Source installation is a developer workflow; install a supported developer Node.js release or use the Windows offline ZIP."
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
  throw "Node.js $nodeVersionText is unsupported for source builds. Install a supported developer Node.js release or use the Windows offline ZIP."
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) "c2000-source-install-$([guid]::NewGuid().ToString('N'))"
$stagingSource = Join-Path $stagingRoot "source"
$stagingPackage = Join-Path $stagingRoot "package"
$stagingNodeModules = Join-Path $stagingSource "node_modules"
$runtimeOut = Join-Path $stagingPackage "dist\src"
$previousRuntimeOut = $env:C2000_BUILD_RUNTIME_OUTDIR
$previousSourceRevision = $env:C2000_BUILD_SOURCE_REVISION
$previousSourceDirty = $env:C2000_BUILD_SOURCE_DIRTY
$sourceRevision = "unknown"
$sourceDirty = "unknown"

if (Get-Command git -ErrorAction SilentlyContinue) {
  $revisionOutput = & git -C $repositoryRoot rev-parse HEAD 2>$null
  $revisionExitCode = $LASTEXITCODE
  if ($revisionExitCode -eq 0) {
    $candidateRevision = ($revisionOutput -join "`n").Trim()
    if ($candidateRevision) { $sourceRevision = $candidateRevision }
  }
  $statusOutput = & git -C $repositoryRoot status --porcelain --untracked-files=no 2>$null
  $statusExitCode = $LASTEXITCODE
  if ($statusExitCode -eq 0) {
    $sourceDirty = if (($statusOutput -join "`n").Trim()) { "true" } else { "false" }
  }
}

New-Item -ItemType Directory -Path $stagingSource | Out-Null
New-Item -ItemType Directory -Path $stagingPackage | Out-Null

try {
  # Build from a disposable source tree. The live checkout, its dist directory,
  # and its node_modules are never rewritten while Codex may be running them.
  foreach ($file in @(
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.src.json"
    )) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $file) -Destination $stagingSource -Force
  }
  foreach ($directory in @("src", "config")) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $directory) -Destination $stagingSource -Recurse -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $stagingSource "scripts") | Out-Null
  foreach ($script in @("scripts\build.mjs", "scripts\build-runtime.mjs")) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $script) -Destination (Join-Path $stagingSource $script) -Force
  }

  $dependenciesReady = $false
  if (-not $ForceDependencyInstall) {
    Push-Location $repositoryRoot
    try {
      & npm.cmd ls --depth=0 --silent *> $null
      $dependenciesReady = $LASTEXITCODE -eq 0
      if ($dependenciesReady) {
        & node -e "require.resolve('typescript/package.json'); require.resolve('esbuild'); require.resolve('@modelcontextprotocol/sdk/server/mcp.js'); const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();" *> $null
        $dependenciesReady = $LASTEXITCODE -eq 0
      }
    } finally {
      Pop-Location
    }
  }

  if ($dependenciesReady) {
    # A junction is read-only from the installer's point of view. It lets a
    # healthy checkout provide build inputs without giving npm any path that it
    # could clean or replace.
    try {
      New-Item -ItemType Junction -Path $stagingNodeModules -Target (Join-Path $repositoryRoot "node_modules") | Out-Null
      Write-Host "Dependencies are current; using the checkout dependencies read-only."
    } catch {
      Write-Host "The checkout dependencies could not be linked safely; installing an isolated dependency tree."
      $dependenciesReady = $false
    }
  }
  if (-not $dependenciesReady) {
    Push-Location $stagingSource
    try {
      Write-Host "Restoring dependencies in the isolated build directory from package-lock.json..."
      & npm.cmd ci --no-audit --fund=false
      Assert-LastExitCode "Isolated npm ci failed. Confirm the active Node version has a compatible better-sqlite3 binary or native build toolchain."
    } finally {
      Pop-Location
    }
  }

  $env:C2000_BUILD_RUNTIME_OUTDIR = $runtimeOut
  $env:C2000_BUILD_SOURCE_REVISION = $sourceRevision
  $env:C2000_BUILD_SOURCE_DIRTY = $sourceDirty
  Push-Location $stagingSource
  try {
    Write-Host "Building into isolated staging directory: $runtimeOut"
    & node scripts\build.mjs -p tsconfig.src.json
    Assert-LastExitCode "Isolated runtime build failed."
  } finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Path (Join-Path $stagingPackage "scripts") | Out-Null
  Copy-Item -LiteralPath (Join-Path $stagingSource "package.json") -Destination $stagingPackage -Force
  Copy-Item -LiteralPath (Join-Path $repositoryRoot "scripts\c2000-mcp-doctor.mjs") -Destination (Join-Path $stagingPackage "scripts") -Force
  Copy-Item -LiteralPath (Join-Path $repositoryRoot "skills") -Destination $stagingPackage -Recurse -Force

  $setupEntrypoint = Join-Path $runtimeOut "installer\index.js"
  $setupArguments = @("install", "--workspace", $repositoryRoot) + @($InstallerArguments)
  & node $setupEntrypoint @setupArguments
  Assert-LastExitCode "C2000 Multicore MCP source installation failed."
} finally {
  $env:C2000_BUILD_RUNTIME_OUTDIR = $previousRuntimeOut
  $env:C2000_BUILD_SOURCE_REVISION = $previousSourceRevision
  $env:C2000_BUILD_SOURCE_DIRTY = $previousSourceDirty
  if (Test-Path -LiteralPath $stagingNodeModules) {
    $stagingNodeModulesItem = Get-Item -LiteralPath $stagingNodeModules -Force
    if (($stagingNodeModulesItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      # PowerShell 7 can throw a NullReferenceException while removing a
      # directory junction with Remove-Item. Directory.Delete removes the
      # reparse point itself and does not traverse the repository target.
      [System.IO.Directory]::Delete($stagingNodeModules, $false)
    }
  }
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}

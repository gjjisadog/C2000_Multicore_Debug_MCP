[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$PackagePath,

  [Parameter(Position = 1)]
  [string]$ChecksumPath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArguments
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) { throw $Message }
}

function Resolve-SingleFile([string]$Description, [object[]]$Candidates) {
  $files = @($Candidates)
  if ($files.Count -eq 0) { throw "No $Description was found." }
  if ($files.Count -gt 1) {
    throw "Multiple $Description files were found; pass -PackagePath and -ChecksumPath explicitly."
  }
  return $files[0].FullName
}

function Resolve-ExistingFile([string]$Description, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description does not exist: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-SafeArchiveEntries([string]$TarCommand, [string]$ArchivePath) {
  $entries = @(& $TarCommand -tzf $ArchivePath)
  Assert-LastExitCode "Failed to inspect the offline package archive."
  if ($entries.Count -eq 0) { throw "The offline package archive is empty." }
  foreach ($entry in $entries) {
    $normalized = "$entry".Replace("\", "/").TrimEnd("/")
    if (
      -not ($normalized -eq "package" -or $normalized.StartsWith("package/")) -or
      $normalized.StartsWith("/") -or
      $normalized -match "(^|/)\.\.(/|$)" -or
      $normalized -match "^[A-Za-z]:"
    ) {
      throw "Unsafe archive entry rejected: $entry"
    }
  }
}

function Assert-PathInside([string]$ChildPath, [string]$ParentPath, [string]$Description) {
  $child = [System.IO.Path]::GetFullPath($ChildPath)
  $parent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd("\", "/")
  if (-not $child.StartsWith("$parent\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description escapes its expected directory: $child"
  }
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -ne "x64") {
  throw "Windows offline installation supports x64; detected $architecture."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 22.12+ LTS (recommended) or 20.19+ LTS."
}

$nodeVersionText = & node -p "process.versions.node"
Assert-LastExitCode "Failed to read the active Node.js version."
$nodeVersion = [version]$nodeVersionText
$nodeSupported = ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -ge 19) -or
  ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12)
if (-not $nodeSupported) {
  throw "Node.js $nodeVersionText is unsupported. Install Node.js 22.12+ LTS (recommended) or 20.19+ LTS."
}

$nodeAbi = & node -p "process.versions.modules"
Assert-LastExitCode "Failed to read the active Node modules ABI."
$expectedTarget = "win32-x64-abi$nodeAbi"
$searchRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

if ($PackagePath) {
  $PackagePath = Resolve-ExistingFile "Offline package" $PackagePath
} else {
  $PackagePath = Resolve-SingleFile "package for $expectedTarget" @(
    Get-ChildItem -LiteralPath $searchRoot -File -Filter "c2000-multicore-mcp-*-$expectedTarget.tgz"
  )
}

if ($ChecksumPath) {
  $ChecksumPath = Resolve-ExistingFile "Checksum metadata" $ChecksumPath
} else {
  $packageDirectory = Split-Path -Parent $PackagePath
  $preferredChecksum = Join-Path $packageDirectory "SHA256SUMS-$expectedTarget.json"
  if (Test-Path -LiteralPath $preferredChecksum -PathType Leaf) {
    $ChecksumPath = (Resolve-Path -LiteralPath $preferredChecksum).Path
  } else {
    $ChecksumPath = Resolve-SingleFile "checksum metadata for $expectedTarget" @(
      Get-ChildItem -LiteralPath $packageDirectory -File -Filter "SHA256SUMS-*.json"
    )
  }
}

$assetName = Split-Path -Leaf $PackagePath
$metadata = Get-Content -Raw -LiteralPath $ChecksumPath | ConvertFrom-Json
$expected = @($metadata.files) | Where-Object { $_.file -eq $assetName } | Select-Object -First 1
if (-not $expected) {
  throw "Checksum metadata does not contain $assetName."
}
if ("$($metadata.target)" -ne $expectedTarget) {
  throw "Checksum metadata targets $($metadata.target), but active Node requires $expectedTarget."
}
if ("$($expected.sha256)" -notmatch "^[0-9a-fA-F]{64}$") {
  throw "Checksum metadata contains an invalid SHA-256 value for $assetName."
}
if ($null -ne $expected.size -and [int64]$expected.size -ne (Get-Item -LiteralPath $PackagePath).Length) {
  throw "Offline package size does not match the checksum metadata for $assetName."
}

Write-Host "Verifying SHA-256 for $assetName..."
$actualHash = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne "$($expected.sha256)".ToLowerInvariant()) {
  throw "SHA-256 mismatch for $assetName."
}

$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tar) { $tar = Get-Command tar -ErrorAction SilentlyContinue }
if (-not $tar) { throw "tar was not found. Windows 10/11 includes tar.exe; enable it and retry." }
Assert-SafeArchiveEntries $tar.Source $PackagePath

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\", "/")
$stagingRoot = Join-Path $temporaryBase "c2000-offline-install-$([guid]::NewGuid().ToString('N'))"
Assert-PathInside $stagingRoot $temporaryBase "Temporary staging path"
New-Item -ItemType Directory -Path $stagingRoot | Out-Null

try {
  Write-Host "Extracting verified runtime..."
  & $tar.Source -xzf $PackagePath -C $stagingRoot
  Assert-LastExitCode "Failed to extract the offline package archive."

  $packageRoot = Join-Path $stagingRoot "package"
  $runtimeRoot = Join-Path $packageRoot "dist\src"
  $manifestPath = Join-Path $runtimeRoot "runtime-manifest.json"
  $installerPath = Join-Path $runtimeRoot "installer\index.js"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Offline package is missing dist/src/runtime-manifest.json."
  }
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Offline package is missing dist/src/installer/index.js."
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.platform -ne "win32" -or $manifest.arch -ne "x64") {
    throw "Runtime package is for $($manifest.platform)-$($manifest.arch), but this machine is win32-x64."
  }
  if ("$($manifest.nodeModulesAbi)" -ne "$nodeAbi") {
    throw "Runtime package ABI $($manifest.nodeModulesAbi) does not match active Node ABI $nodeAbi. Use the $expectedTarget package; npm adaptation is intentionally disabled offline."
  }

  foreach ($binding in @($manifest.nativeBindings)) {
    if ("$($binding.sha256)" -notmatch "^[0-9a-fA-F]{64}$") {
      throw "Runtime manifest contains an invalid native binding SHA-256 value."
    }
    $bindingPath = Join-Path $runtimeRoot "$($binding.path)"
    Assert-PathInside $bindingPath $runtimeRoot "Native binding path"
    if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
      throw "Runtime native binding is missing: $($binding.path)"
    }
    $bindingHash = (Get-FileHash -LiteralPath $bindingPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($bindingHash -ne "$($binding.sha256)".ToLowerInvariant()) {
      throw "Runtime native binding SHA-256 mismatch: $($binding.path)"
    }
  }

  Write-Host "Installing C2000 Multicore MCP for Node $nodeVersionText (ABI $nodeAbi)..."
  & node $installerPath install @InstallerArguments
  Assert-LastExitCode "C2000 Multicore MCP offline installation or doctor verification failed."
} finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Assert-PathInside $stagingRoot $temporaryBase "Temporary cleanup path"
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}

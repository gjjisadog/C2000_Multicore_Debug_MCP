[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArguments
)

$ErrorActionPreference = "Stop"

function Assert-PathInside([string]$ChildPath, [string]$ParentPath, [string]$Description) {
  $child = [System.IO.Path]::GetFullPath($ChildPath)
  $parent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd("\", "/")
  if (-not $child.StartsWith("$parent\", [System.StringComparison]::OrdinalIgnoreCase) -and
      $child -ne $parent) {
    throw "$Description escapes its expected directory: $child"
  }
}

function Resolve-RequiredFile([string]$Description, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description is missing: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-SafeRelativePath([string]$Path, [string]$Description) {
  $normalized = "$Path".Replace("\", "/")
  if ([string]::IsNullOrWhiteSpace($normalized) -or
      $normalized.StartsWith("/") -or
      $normalized -match "^[A-Za-z]:" -or
      $normalized -match "(^|/)\.\.(/|$)" -or
      $normalized -match "//") {
    throw "$Description contains an unsafe path: $Path"
  }
  return $normalized.TrimStart("./")
}

function Read-JsonFile([string]$Description, [string]$Path) {
  try {
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    throw "$Description is missing or invalid: $Path ($($_.Exception.Message))"
  }
}

function Assert-ChecksumManifest([string]$BundleRoot, [object]$Checksums) {
  if ("$($Checksums.target)" -ne "win32-x64") {
    throw "Checksum metadata targets $($Checksums.target), but this installer requires win32-x64."
  }
  $entries = @($Checksums.files)
  if ($entries.Count -eq 0) { throw "SHA256SUMS.json contains no file entries." }
  $seen = @{}
  foreach ($entry in $entries) {
    $relative = Assert-SafeRelativePath "$($entry.file)" "Checksum metadata"
    if ($relative -eq "SHA256SUMS.json") { throw "SHA256SUMS.json cannot contain a self-referential checksum." }
    if ($seen.ContainsKey($relative)) { throw "Checksum metadata contains a duplicate path: $relative" }
    $seen[$relative] = $true
    if ("$($entry.sha256)" -notmatch "^[0-9a-fA-F]{64}$") {
      throw "Checksum metadata contains an invalid SHA-256 value for $relative."
    }
    $filePath = Join-Path $BundleRoot $relative.Replace("/", "\")
    Assert-PathInside $filePath $BundleRoot "Checksum entry"
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw "Checksum entry points to a missing file: $relative"
    }
    $item = Get-Item -LiteralPath $filePath
    if ($null -ne $entry.size -and [int64]$entry.size -ne $item.Length) {
      throw "Size mismatch for $relative."
    }
    $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne "$($entry.sha256)".ToLowerInvariant()) {
      throw "SHA-256 mismatch for $relative."
    }
  }
  foreach ($required in @("manifest.json", "install.ps1", "runtime/node.exe", "runtime/LICENSE", "mcp/dist/src/runtime-manifest.json", "mcp/dist/src/installer/index.js")) {
    if (-not $seen.ContainsKey($required)) { throw "SHA256SUMS.json does not cover required file: $required" }
  }
  $checksumPath = [System.IO.Path]::GetFullPath((Join-Path $BundleRoot "SHA256SUMS.json"))
  $bundlePrefix = $BundleRoot.TrimEnd("\", "/") + "\"
  foreach ($file in Get-ChildItem -LiteralPath $BundleRoot -Recurse -File) {
    if ([System.IO.Path]::GetFullPath($file.FullName) -eq $checksumPath) { continue }
    $relative = $file.FullName.Substring($bundlePrefix.Length).Replace("\", "/")
    if (-not $seen.ContainsKey($relative)) { throw "Bundle file is not covered by SHA256SUMS.json: $relative" }
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "The C2000 MCP offline package supports Windows only."
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The C2000 MCP offline package supports Windows x64 only."
}

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) { $scriptRoot = (Get-Location).Path }
$bundleRoot = (Resolve-Path -LiteralPath $scriptRoot).Path
$manifestPath = Resolve-RequiredFile "Offline bundle manifest" (Join-Path $bundleRoot "manifest.json")
$checksumPath = Resolve-RequiredFile "Offline checksum metadata" (Join-Path $bundleRoot "SHA256SUMS.json")
$manifest = Read-JsonFile "Offline bundle manifest" $manifestPath
$checksums = Read-JsonFile "Offline checksum metadata" $checksumPath
Assert-ChecksumManifest $bundleRoot $checksums

if ("$($manifest.schemaVersion)" -ne "1") { throw "Unsupported offline bundle manifest schema: $($manifest.schemaVersion)" }
if ("$($manifest.artifact.target)" -ne "offline-win32-x64" -and "$($manifest.artifact.target)" -ne "win32-x64") {
  throw "This package is not the Windows x64 C2000 MCP offline artifact."
}
$runtime = $manifest.runtime
if (-not $runtime -or "$($runtime.name)" -ne "node" -or "$($runtime.platform)" -ne "win32" -or "$($runtime.arch)" -ne "x64") {
  throw "Offline bundle runtime metadata is not win32-x64 Node."
}
if ("$($runtime.version)" -notmatch '^\d+\.\d+\.\d+$' -or "$($runtime.nodeVersion)" -ne "v$($runtime.version)") {
  throw "Offline bundle must declare a complete Node runtime version."
}
if ("$($runtime.modulesAbi)" -notmatch '^\d+$') { throw "Offline bundle Node ABI metadata is invalid." }
if ("$($runtime.sha256)" -notmatch "^[0-9a-fA-F]{64}$") { throw "Offline bundle Node SHA-256 metadata is invalid." }
if ("$($runtime.distribution.archiveSha256)" -notmatch "^[0-9a-fA-F]{64}$") { throw "Offline bundle distribution SHA-256 metadata is invalid." }
if ("$($runtime.distribution.source)" -notmatch '^https://nodejs\.org/') { throw "Offline bundle runtime source is not the official Node distribution." }
if ("$($runtime.executable)" -ne "runtime/node.exe") { throw "Offline bundle runtime executable metadata is invalid." }

$nodePath = Resolve-RequiredFile "Bundled Node executable" (Join-Path $bundleRoot "runtime\node.exe")
$nodeHash = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeHash -ne "$($runtime.sha256)".ToLowerInvariant()) { throw "Bundled Node executable SHA-256 does not match manifest." }

$nodeProbeText = & $nodePath -p "JSON.stringify({nodeVersion:process.version,nodeModulesAbi:process.versions.modules,platform:process.platform,arch:process.arch})"
if ($LASTEXITCODE -ne 0) { throw "The bundled Node executable could not be started." }
try { $nodeProbe = $nodeProbeText | ConvertFrom-Json } catch { throw "Bundled Node version probe returned invalid JSON." }
if ("$($nodeProbe.nodeVersion)" -ne "$($runtime.nodeVersion)" -or
    "$($nodeProbe.nodeModulesAbi)" -ne "$($runtime.modulesAbi)" -or
    "$($nodeProbe.platform)" -ne "win32" -or
    "$($nodeProbe.arch)" -ne "x64") {
  throw "Bundled Node version/ABI/platform does not match manifest."
}

$mcpRoot = (Resolve-Path -LiteralPath (Join-Path $bundleRoot "mcp")).Path
$mcpManifestPath = Resolve-RequiredFile "MCP runtime manifest" (Join-Path $mcpRoot "dist\src\runtime-manifest.json")
$mcpManifest = Read-JsonFile "MCP runtime manifest" $mcpManifestPath
if ($mcpManifest.runtime.bundledNode -ne $true) { throw "MCP runtime manifest is not marked as using the private Node runtime." }
if ("$($mcpManifest.runtime.nodeVersion)" -ne "$($runtime.nodeVersion)" -or
    "$($mcpManifest.runtime.modulesAbi)" -ne "$($runtime.modulesAbi)") {
  throw "MCP runtime manifest and offline runtime metadata disagree."
}
if ("$($mcpManifest.runtime.executable)" -ne "runtime/node.exe") { throw "MCP runtime executable metadata is invalid." }
$sqliteBindings = @($mcpManifest.nativeBindings | Where-Object { "$($_.name)" -eq "better_sqlite3.node" })
if ($sqliteBindings.Count -ne 1 -or "$($sqliteBindings[0].abi)" -ne "$($runtime.modulesAbi)") {
  throw "better_sqlite3.node ABI metadata does not match the bundled Node ABI."
}
foreach ($binding in @($mcpManifest.nativeBindings)) {
  $relativeBinding = Assert-SafeRelativePath "$($binding.path)" "MCP native binding"
  $bindingPath = Join-Path $mcpRoot "dist\src\$($relativeBinding.Replace('/', '\'))"
  Assert-PathInside $bindingPath (Join-Path $mcpRoot "dist\src") "MCP native binding"
  if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) { throw "MCP native binding is missing: $relativeBinding" }
  $actualBindingHash = (Get-FileHash -LiteralPath $bindingPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualBindingHash -ne "$($binding.sha256)".ToLowerInvariant()) { throw "MCP native binding SHA-256 mismatch: $relativeBinding" }
}

$installerPath = Resolve-RequiredFile "Offline MCP installer" (Join-Path $mcpRoot "dist\src\installer\index.js")
$previousBundleRoot = $env:C2000_MCP_OFFLINE_BUNDLE_ROOT
try {
  $env:C2000_MCP_OFFLINE_BUNDLE_ROOT = $bundleRoot
  & $nodePath $installerPath install @InstallerArguments
  if ($LASTEXITCODE -ne 0) { throw "C2000 MCP installation or doctor verification failed." }
} finally {
  $env:C2000_MCP_OFFLINE_BUNDLE_ROOT = $previousBundleRoot
}

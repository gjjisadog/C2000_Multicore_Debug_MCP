param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArguments
)

$ErrorActionPreference = "Stop"

$repository = "gjjisadog/C2000_Multicore_Debug_MCP"
$tag = if ($env:C2000_MCP_VERSION) { $env:C2000_MCP_VERSION } else { "v0.7.0" }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -ne "x64") {
  throw "Windows one-command installation currently supports x64; detected $architecture."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 22.12+ LTS (recommended), 24.x, or 20.19+ LTS."
}
$nodeVersionText = & node -p "process.versions.node"
if ($LASTEXITCODE -ne 0) { throw "Failed to read the active Node.js version." }
$nodeVersion = [version]$nodeVersionText
$nodeSupported = ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -ge 19) -or
  ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12) -or
  ($nodeVersion.Major -eq 24)
if (-not $nodeSupported) {
  throw "Node.js $nodeVersionText is unsupported. Install Node.js 22.12+ LTS (recommended), 24.x, or 20.19+ LTS."
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI ('gh') was not found. Install it and authenticate before installing this private release."
}
& gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI authentication is invalid. Run 'gh auth login --hostname github.com' and retry."
}

$nodeAbi = & node -p "process.versions.modules"
if ($LASTEXITCODE -ne 0) { throw "Failed to read the active Node modules ABI." }
$target = "win32-x64-abi$nodeAbi"
$assetPattern = "c2000-multicore-mcp-*-$target.tgz"
$checksumName = "SHA256SUMS-$target.json"
$offlineInstallerName = "install-offline.ps1"
$downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "c2000-multicore-mcp-$tag-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $downloadDirectory | Out-Null

try {
  & gh release download $tag --repo $repository --pattern $assetPattern --pattern $checksumName --pattern $offlineInstallerName --dir $downloadDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to download the $target package. Confirm the release exists and the authenticated account can access it."
  }

  $assetFiles = @(Get-ChildItem -LiteralPath $downloadDirectory -File -Filter $assetPattern)
  if ($assetFiles.Count -ne 1) {
    throw "Expected exactly one $target package in release $tag; found $($assetFiles.Count)."
  }
  $assetPath = $assetFiles[0].FullName
  $checksumPath = Join-Path $downloadDirectory $checksumName
  $offlineInstallerPath = Join-Path $downloadDirectory $offlineInstallerName
  & powershell -NoProfile -ExecutionPolicy Bypass -File $offlineInstallerPath -PackagePath $assetPath -ChecksumPath $checksumPath @InstallerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "C2000 Multicore MCP installation failed."
  }
} finally {
  if (Test-Path -LiteralPath $downloadDirectory) {
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
  }
}

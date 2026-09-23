[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArguments
)

$ErrorActionPreference = "Stop"
$repository = "gjjisadog/C2000_Multicore_Debug_MCP"
$tag = $env:C2000_MCP_VERSION
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -ne "x64") { throw "Windows online installation supports x64; detected $architecture." }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI ('gh') is required only for this online bootstrap. Transfer the offline ZIP to a disconnected machine to install without gh."
}
& gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI authentication is invalid. Run 'gh auth login --hostname github.com' and retry."
}
if ([string]::IsNullOrWhiteSpace($tag)) {
  $latestTag = & gh release view --repo $repository --json tagName --jq .tagName
  if ($LASTEXITCODE -ne 0) { throw "Could not resolve the latest C2000 MCP release tag." }
  $tag = ($latestTag -join "").Trim()
  if ([string]::IsNullOrWhiteSpace($tag)) { throw "Could not resolve the latest C2000 MCP release tag." }
}

$version = $tag -replace '^v', ''
$assetName = "c2000-multicore-mcp-$version-offline-win32-x64.zip"
$downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "c2000-multicore-mcp-online-$([guid]::NewGuid().ToString('N'))"
$bundleDirectory = Join-Path $downloadDirectory "bundle"
New-Item -ItemType Directory -Path $downloadDirectory | Out-Null

try {
  & gh release download $tag --repo $repository --pattern $assetName --dir $downloadDirectory
  if ($LASTEXITCODE -ne 0) { throw "Failed to download $assetName from release $tag." }
  $archivePath = Join-Path $downloadDirectory $assetName
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Downloaded release asset is missing: $assetName" }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $bundleDirectory -Force
  $installerPath = Join-Path $bundleDirectory "install.ps1"
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "The downloaded offline bundle does not contain install.ps1." }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installerPath @InstallerArguments
  if ($LASTEXITCODE -ne 0) { throw "C2000 MCP offline installation failed." }
} finally {
  if (Test-Path -LiteralPath $downloadDirectory) {
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
  }
}

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArguments
)

$ErrorActionPreference = "Stop"

$repository = "gjjisadog/C2000_Multicore_Debug_MCP"
$tag = if ($env:C2000_MCP_VERSION) { $env:C2000_MCP_VERSION } else { "v0.6.1" }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -ne "x64") {
  throw "Windows one-command installation currently supports x64; detected $architecture."
}

$nodeVersion = & node -p "process.versions.node" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Node.js >=20.19 <21, >=22.12 <23, or 24 is required; Node.js was not found."
}
$nodeParts = $nodeVersion.Split(".")
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = [int]$nodeParts[1]
$supportedNode = ($nodeMajor -eq 20 -and $nodeMinor -ge 19) `
  -or ($nodeMajor -eq 22 -and $nodeMinor -ge 12) `
  -or ($nodeMajor -eq 24)
if (-not $supportedNode) {
  throw "Node.js >=20.19 <21, >=22.12 <23, or 24 is required; active Node is v$nodeVersion."
}

$assetName = "c2000-multicore-mcp-$($tag.TrimStart('v'))-win32-x64.tgz"
$downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "c2000-multicore-mcp-$tag-win32-x64"
New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null

& gh release download $tag --repo $repository --pattern $assetName --dir $downloadDirectory --clobber
if ($LASTEXITCODE -ne 0) {
  throw "Failed to download $assetName. Confirm 'gh auth status' succeeds and the private repository is accessible."
}

$assetPath = (Join-Path $downloadDirectory $assetName).Replace("\", "/")
& npm exec --yes "--package=file:$assetPath" -- c2000-multicore-setup install @InstallerArguments
if ($LASTEXITCODE -ne 0) {
  throw "C2000 Multicore MCP installation failed."
}

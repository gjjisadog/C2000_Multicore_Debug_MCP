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

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($LASTEXITCODE -ne 0 -or $nodeMajor -notin @(20, 22, 24)) {
  throw "Node.js 20, 22, or 24 LTS is required."
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

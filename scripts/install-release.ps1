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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found. Install Node.js 22.12+ LTS (recommended) or 20.19+ LTS."
}
$nodeVersionText = & node -p "process.versions.node"
if ($LASTEXITCODE -ne 0) { throw "Failed to read the active Node.js version." }
$nodeVersion = [version]$nodeVersionText
$nodeSupported = ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -ge 19) -or
  ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 12)
if (-not $nodeSupported) {
  throw "Node.js $nodeVersionText is unsupported. Install Node.js 22.12+ LTS (recommended) or 20.19+ LTS. Node.js 24 is not supported by the current Windows native dependencies."
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI ('gh') was not found. Install it and authenticate before installing this private release."
}
& gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI authentication is invalid. Run 'gh auth login --hostname github.com' and retry."
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm.cmd was not found next to the active Node.js installation."
}

$assetName = "c2000-multicore-mcp-$($tag.TrimStart('v'))-win32-x64.tgz"
$checksumName = "SHA256SUMS-win32-x64.json"
$downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "c2000-multicore-mcp-$tag-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $downloadDirectory | Out-Null

try {
  & gh release download $tag --repo $repository --pattern $assetName --pattern $checksumName --dir $downloadDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to download $assetName. Confirm the release exists and the authenticated account can access it."
  }

  $assetPath = Join-Path $downloadDirectory $assetName
  $checksumPath = Join-Path $downloadDirectory $checksumName
  $metadata = Get-Content -Raw -LiteralPath $checksumPath | ConvertFrom-Json
  $expected = @($metadata.files) | Where-Object { $_.file -eq $assetName } | Select-Object -First 1
  if (-not $expected) { throw "Release checksum metadata does not contain $assetName." }
  $actualHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne "$($expected.sha256)".ToLowerInvariant()) {
    throw "Release checksum mismatch for $assetName."
  }

  $npmAssetPath = $assetPath.Replace("\", "/")
  & npm.cmd exec --yes "--package=file:$npmAssetPath" -- c2000-multicore-setup install @InstallerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "C2000 Multicore MCP installation failed."
  }
} finally {
  if (Test-Path -LiteralPath $downloadDirectory) {
    Remove-Item -LiteralPath $downloadDirectory -Recurse -Force
  }
}

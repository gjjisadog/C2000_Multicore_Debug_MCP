[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallRoot,
  [string]$CodexHome
)

$ErrorActionPreference = "Stop"
$managedStart = "# BEGIN c2000-multicore-mcp managed block"
$managedEnd = "# END c2000-multicore-mcp managed block"

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:USERPROFILE ".c2000-multicore-mcp"
}
if (-not $CodexHome) {
  $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$configPath = Join-Path ([System.IO.Path]::GetFullPath($CodexHome)) "config.toml"

if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $content = Get-Content -Raw -LiteralPath $configPath
  $start = $content.IndexOf($managedStart)
  if ($start -ge 0) {
    $end = $content.IndexOf($managedEnd, $start)
    if ($end -lt 0) { throw "Codex config contains an incomplete c2000-multicore-mcp managed block." }
    $updated = ($content.Substring(0, $start) + $content.Substring($end + $managedEnd.Length)).TrimEnd()
    if ($PSCmdlet.ShouldProcess($configPath, "remove the C2000 MCP managed block")) {
      Set-Content -LiteralPath $configPath -Value ($updated + "`n") -NoNewline
    }
  }
}

if (Test-Path -LiteralPath $InstallRoot) {
  if ($PSCmdlet.ShouldProcess($InstallRoot, "remove the C2000 MCP installation and its runtime data")) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  Write-Output (ConvertTo-Json @{ removed = $true; installRoot = $InstallRoot; configPath = $configPath } -Compress)
} else {
  Write-Output (ConvertTo-Json @{ removed = $false; installRoot = $InstallRoot; configPath = $configPath } -Compress)
}

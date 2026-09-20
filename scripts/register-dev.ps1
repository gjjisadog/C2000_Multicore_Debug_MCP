param(
  [string]$ConfigPath = $env:C2000_MCP_CONFIG
)

$ErrorActionPreference = "Stop"

function Write-ManagedCodexConfig {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigFile,
    [Parameter(Mandatory = $true)][string]$ServerName,
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath
  )

  $parent = Split-Path -Parent $ConfigFile
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $existing = if (Test-Path -LiteralPath $ConfigFile) { Get-Content -Raw -LiteralPath $ConfigFile } else { "" }
  $withoutBlock = Remove-ManagedBlock -Content $existing
  $withoutServer = Remove-ServerTables -Content $withoutBlock -ServerName $ServerName
  $block = @(
    "# BEGIN c2000-multicore-mcp managed block",
    "# Registered by scripts/register-dev.ps1",
    "[mcp_servers.$ServerName]",
    "command = $(ConvertTo-TomlString $NodeExecutable)",
    "args = [$(ConvertTo-TomlString $LauncherPath)]",
    "",
    "[mcp_servers.$ServerName.env]",
    "C2000_MCP_CONFIG = $(ConvertTo-TomlString $ConfigPath)",
    'C2000_MCP_DEV_MODE = "1"',
    "# END c2000-multicore-mcp managed block"
  ) -join "`n"
  $prefix = $withoutServer.TrimEnd()
  $content = if ($prefix) { "$prefix`n`n$block`n" } else { "$block`n" }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ConfigFile, $content, $utf8NoBom)
}

function Remove-ManagedBlock {
  param([Parameter(Mandatory = $true)][string]$Content)
  $startMarker = "# BEGIN c2000-multicore-mcp managed block"
  $endMarker = "# END c2000-multicore-mcp managed block"
  $start = $Content.IndexOf($startMarker, [System.StringComparison]::Ordinal)
  if ($start -lt 0) { return $Content }
  $end = $Content.IndexOf($endMarker, $start, [System.StringComparison]::Ordinal)
  if ($end -lt 0) { throw "Codex config contains an incomplete c2000-multicore-mcp managed block." }
  return $Content.Remove($start, $end + $endMarker.Length - $start)
}

function Remove-ServerTables {
  param(
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$ServerName
  )
  $prefix = "mcp_servers.$ServerName"
  $removing = $false
  $kept = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($Content -split "`r?`n")) {
    if ($line -match '^\s*\[([^\]]+)\]') {
      $header = $Matches[1].Trim()
      $removing = $header -eq $prefix -or $header.StartsWith("$prefix.", [System.StringComparison]::Ordinal)
    }
    if (-not $removing) { $kept.Add($line) }
  }
  return ($kept -join "`n")
}

function ConvertTo-TomlString([string]$Value) {
  $normalized = $Value.Replace("\", "/").Replace('"', '\"')
  return '"' + $normalized + '"'
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$launcherPath = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot "scripts\codex-dev-launcher.mjs")).Path
$nodeCommand = Get-Command node.exe,node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) {
  throw "Node.js was not found. Run npm ci with a supported developer Node.js release first."
}
$nodeExecutable = (Resolve-Path -LiteralPath $nodeCommand.Source).Path

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $repositoryRoot "examples\f28p65x.config.json"
}
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$serverName = "c2000-multicore"
$addArguments = @(
  "mcp", "add", $serverName,
  "--env", "C2000_MCP_CONFIG=$ConfigPath",
  "--env", "C2000_MCP_DEV_MODE=1",
  "--", $nodeExecutable, $launcherPath
)

$codexCommand = Get-Command codex.exe,codex.cmd,codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codexCommand) {
  & $codexCommand.Source @addArguments
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Registered $serverName with the fixed development launcher (codex mcp add)."
    exit 0
  }

  # `codex mcp add` rejects a duplicate name on some CLI versions. Removing
  # exactly this server name and adding it again is the idempotent overwrite.
  & $codexCommand.Source "mcp" "remove" $serverName *> $null
  & $codexCommand.Source @addArguments
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Replaced $serverName with the fixed development launcher (codex mcp add)."
    exit 0
  }
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$codexConfigPath = Join-Path $codexHome "config.toml"
Write-ManagedCodexConfig -ConfigFile $codexConfigPath -ServerName $serverName -NodeExecutable $nodeExecutable -LauncherPath $launcherPath -ConfigPath $ConfigPath
Write-Host "Registered $serverName in $codexConfigPath (managed config fallback)."

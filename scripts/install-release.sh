#!/usr/bin/env bash
set -euo pipefail

repository="gjjisadog/C2000_Multicore_Debug_MCP"
tag="${C2000_MCP_VERSION:-v0.6.1}"

case "$(uname -m)" in
  arm64) target="darwin-arm64" ;;
  x86_64) target="darwin-x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

node_major="$(node -p "process.versions.node.split('.')[0]")"
case "$node_major" in
  20|22|24) ;;
  *) echo "Node.js 20, 22, or 24 LTS is required." >&2; exit 1 ;;
esac

asset_name="c2000-multicore-mcp-${tag#v}-${target}.tgz"
download_directory="${TMPDIR:-/tmp}/c2000-multicore-mcp-${tag}-${target}"
mkdir -p "$download_directory"

if ! gh release download "$tag" \
  --repo "$repository" \
  --pattern "$asset_name" \
  --dir "$download_directory" \
  --clobber; then
  echo "Failed to download $asset_name. Confirm 'gh auth status' succeeds and the private repository is accessible." >&2
  exit 1
fi

npm exec --yes \
  "--package=file:$download_directory/$asset_name" \
  -- c2000-multicore-setup install "$@"

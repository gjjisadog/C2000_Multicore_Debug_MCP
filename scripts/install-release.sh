#!/usr/bin/env bash
set -euo pipefail

repository="gjjisadog/C2000_Multicore_Debug_MCP"
tag="${C2000_MCP_VERSION:-v0.7.0}"

case "$(uname -m)" in
  arm64) target="darwin-arm64" ;;
  x86_64) target="darwin-x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "Node.js was not found. Install Node.js 22.12+ LTS (recommended) or 20.19+ LTS." >&2
  exit 1
}
if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) ? 0 : 1);
'; then
  echo "Node.js $(node -p 'process.versions.node') is unsupported. Install Node.js 22.12+ LTS (recommended) or 20.19+ LTS." >&2
  exit 1
fi

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI ('gh') was not found. Install it and authenticate before installing this private release." >&2
  exit 1
}
if ! gh auth status --hostname github.com; then
  echo "GitHub CLI authentication is invalid. Run 'gh auth login --hostname github.com' and retry." >&2
  exit 1
fi
command -v npm >/dev/null 2>&1 || {
  echo "npm was not found next to the active Node.js installation." >&2
  exit 1
}

asset_name="c2000-multicore-mcp-${tag#v}-${target}.tgz"
checksum_name="SHA256SUMS-${target}.json"
download_directory="$(mktemp -d "${TMPDIR:-/tmp}/c2000-multicore-mcp-${tag}-${target}.XXXXXX")"
trap 'rm -rf "$download_directory"' EXIT

if ! gh release download "$tag" \
  --repo "$repository" \
  --pattern "$asset_name" \
  --pattern "$checksum_name" \
  --dir "$download_directory"; then
  echo "Failed to download $asset_name. Confirm the release exists and the authenticated account can access it." >&2
  exit 1
fi

node - "$download_directory/$checksum_name" "$download_directory/$asset_name" "$asset_name" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [metadataPath, assetPath, assetName] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const expected = metadata.files.find(candidate => candidate.file === assetName);
if (!expected) throw new Error(`Release checksum metadata does not contain ${assetName}.`);
const actual = crypto.createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
if (actual !== expected.sha256.toLowerCase()) throw new Error(`Release checksum mismatch for ${assetName}.`);
NODE

npm exec --yes \
  "--package=file:$download_directory/$asset_name" \
  -- c2000-multicore-setup install "$@"

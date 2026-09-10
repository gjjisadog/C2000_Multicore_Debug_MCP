#!/usr/bin/env bash
set -euo pipefail

repository="gjjisadog/C2000_Multicore_Debug_MCP"
tag="${C2000_MCP_VERSION:-v0.7.0}"

case "$(uname -m)" in
  arm64) target="darwin-arm64" ;;
  x86_64) target="darwin-x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI ('gh') was not found. Install it and authenticate before installing this private release." >&2
  exit 1
}
if ! gh auth status --hostname github.com; then
  echo "GitHub CLI authentication is invalid. Run 'gh auth login --hostname github.com' and retry." >&2
  exit 1
fi
is_supported_node() {
  "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(
      (major === 20 && minor >= 19)
      || (major === 22 && minor >= 12)
      || major === 24
        ? 0
        : 1
    );
  ' >/dev/null 2>&1
}

active_node="$(command -v node || true)"
node_executable=""
node_candidates=(
  "$active_node"
  "$(command -v node24 || true)"
  "$(command -v node22 || true)"
  "$(command -v node20 || true)"
  "/opt/homebrew/opt/node@24/bin/node"
  "/opt/homebrew/opt/node@22/bin/node"
  "/opt/homebrew/opt/node@20/bin/node"
  "/usr/local/opt/node@24/bin/node"
  "/usr/local/opt/node@22/bin/node"
  "/usr/local/opt/node@20/bin/node"
)
for candidate in "${node_candidates[@]}"; do
  if [[ -n "$candidate" && -x "$candidate" ]] && is_supported_node "$candidate"; then
    node_executable="$candidate"
    break
  fi
done

if [[ -z "$node_executable" ]]; then
  detected_version="$("${active_node:-node}" --version 2>/dev/null || echo "not found")"
  echo "Node.js >=20.19 <21, >=22.12 <23, or 24 is required; active Node is $detected_version." >&2
  echo "Install an LTS release (for example 'brew install node@22') and rerun this command." >&2
  exit 1
fi

node_directory="$(dirname "$node_executable")"
npm_executable="$(PATH="$node_directory:$PATH" command -v npm || true)"
if [[ -z "$npm_executable" ]]; then
  echo "npm was not found next to the supported Node runtime at $node_executable." >&2
  exit 1
fi
if [[ "$node_executable" != "$active_node" ]]; then
  echo "Using compatible Node.js $("$node_executable" --version) from $node_executable." >&2
fi

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

"$node_executable" - "$download_directory/$checksum_name" "$download_directory/$asset_name" "$asset_name" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [metadataPath, assetPath, assetName] = process.argv.slice(2);
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const expected = metadata.files.find(candidate => candidate.file === assetName);
if (!expected) throw new Error(`Release checksum metadata does not contain ${assetName}.`);
const actual = crypto.createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
if (actual !== expected.sha256.toLowerCase()) throw new Error(`Release checksum mismatch for ${assetName}.`);
NODE

PATH="$node_directory:$PATH" "$npm_executable" exec --yes \
  "--package=file:$download_directory/$asset_name" \
  -- c2000-multicore-setup install "$@"

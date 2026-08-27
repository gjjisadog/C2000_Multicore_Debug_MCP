# C2000 MCP Offline Package — Windows x64

This package is the standalone Windows x64 distribution of C2000 MCP. It
contains the exact Node.js runtime used to build and validate this release, the
bundled MCP JavaScript, native bindings, installer, doctor, and Codex skill.

The target machine does not need Node.js, npm, npx, Git, GitHub CLI, Python,
Visual Studio Build Tools, node-gyp, or an Internet connection to install or
run the MCP. Do not install another Node version and do not modify `PATH`.

## Install

1. Copy `c2000-multicore-mcp-x.y.z-offline-win32-x64.zip` to the Windows x64
   machine and extract it to a directory you control.
2. Open PowerShell in the extracted directory.
3. Run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

The installer verifies the bundle manifest and every SHA-256 entry, starts the
private `runtime\node.exe`, checks its complete version and ABI, verifies and
loads SQLite native code, installs an immutable version slot, registers the
MCP, and runs the doctor handshake. Installation is per-user by default at
`%USERPROFILE%\.c2000-multicore-mcp`; it does not require administrator rights.

If Codex is not installed yet, install the MCP runtime without registration:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --no-register
```

When the Codex CLI is unavailable, the normal install also succeeds and writes
only the C2000 MCP managed block to `%USERPROFILE%\.codex\config.toml`.
Unrelated Codex settings and MCP servers are preserved. Restart Codex after a
successful registration.

## Upgrade and uninstall

Each release is installed into an immutable `versions\` slot. `current.json`
records the active slot, entrypoint, configuration, and private runtime path.
Reinstalling an existing version reuses its slot; `--force` creates a
build-fingerprinted side-by-side slot, so an in-use MCP process is not deleted.
The managed Codex block is updated to the absolute private runtime path:

```toml
command = "C:/Users/<user>/.c2000-multicore-mcp/runtime/node.exe"
args = ["C:/Users/<user>/.c2000-multicore-mcp/versions/<slot>/dist/src/index.js"]
```

To remove the installed MCP and only its managed Codex block:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

The installer cleans temporary download, extraction, and `.installing-*`
staging paths on success or failure. It never runs npm, node-gyp, a package
manager, or a network repair step.

## What remains external

The offline package contains the JavaScript runtime, the fixed Node executable,
`better_sqlite3.node`, and the optional Koffi package/native binding. It does
not redistribute third-party hardware software:

- CCS and C2000Ware/DSS must be installed separately for CCS-backed debug.
- XDS110 hardware and its TI drivers remain external.
- PCAN hardware requires the official PEAK PCAN-Basic installation. The
  licensed `PCANBasic.dll` is discovered from that installation and is not
  copied into this package. Missing PEAK software affects PCAN hardware mode,
  not ordinary CCS/XDS110 MCP installation.
- Codex itself remains an optional external application.

## Internal runtime metadata

The Windows release currently pins Node.js `22.12.0` for win32-x64. Its modules
ABI (`127`) and the native binding hashes are implementation details recorded
in `manifest.json`, `SHA256SUMS.json`, and `mcp\dist\src\runtime-manifest.json`.
End users should select the offline package, not a Node or ABI variant.

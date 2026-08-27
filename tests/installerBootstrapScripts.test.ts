import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

describe("installer bootstrap scripts", () => {
  test("Windows release bootstrap fails fast and verifies the private release asset", async () => {
    const source = await readFile("scripts/install-release.ps1", "utf8");
    expect(source).toContain("gh auth status --hostname github.com");
    expect(source).toContain("offline-win32-x64.zip");
    expect(source).toContain("install.ps1");
    expect(source).not.toContain("Get-Command node");
    expect(source).not.toContain("process.versions.modules");
    expect(source).not.toContain("npm.cmd exec");
    expect(source).toContain("finally");
  });

  test("Windows offline bootstrap verifies and installs without npm or network access", async () => {
    const source = await readFile("scripts/install-offline.ps1", "utf8");
    expect(source).toContain("Get-FileHash");
    expect(source).toContain("process.versions.modules");
    expect(source).toContain("runtime-manifest.json");
    expect(source).toContain("dist\\src");
    expect(source).toContain("installer\\index.js");
    expect(source).toContain("runtime\\node.exe");
    expect(source).toContain("& $nodePath $installerPath install @InstallerArguments");
    expect(source).toContain("$env:C2000_MCP_OFFLINE_BUNDLE_ROOT");
    expect(source).not.toContain("& npm");
    expect(source).not.toContain("npm.cmd");
    expect(source).not.toContain("gh ");
  });

  test("source installation builds outside the repository dist directory", async () => {
    const source = await readFile("scripts/install-source.ps1", "utf8");
    expect(source).toContain("C2000_BUILD_RUNTIME_OUTDIR");
    expect(source).toContain("c2000-source-install-");
    expect(source).toContain("Dependencies are current; skipping npm ci.");
    expect(source).toContain("Remove-Item -LiteralPath $stagingRoot");
    expect(source).not.toContain("daemon:stop");
    expect(source).not.toContain("Stop-Process");
  });

  test("macOS release bootstrap performs the same auth, version, checksum, and cleanup gates", async () => {
    const source = await readFile("scripts/install-release.sh", "utf8");
    expect(source).toContain("gh auth status --hostname github.com");
    expect(source).toContain("major === 22 && minor >= 12");
    expect(source).toContain("major === 24");
    expect(source).toContain("SHA256SUMS-${target}.json");
    expect(source).toContain("createHash(\"sha256\")");
    expect(source).toContain("trap 'rm -rf \"$download_directory\"' EXIT");
  });

  test("release automation publishes one fixed-runtime Windows offline bundle", async () => {
    const source = await readFile(".github/workflows/release.yml", "utf8");
    expect(source).toContain("target: win32-x64");
    expect(source).toContain("C2000_FIXED_RUNTIME_BUILD");
    expect(source).toContain("config/runtime-manifest.json");
    expect(source).toContain("offline-win32-x64.zip");
    expect(source).not.toContain("target: win32-x64-abi115");
    expect(source).not.toContain("target: win32-x64-abi127");
    expect(source).not.toContain("target: win32-x64-abi137");
  });
});

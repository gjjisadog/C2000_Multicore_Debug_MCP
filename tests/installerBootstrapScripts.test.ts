import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

describe("installer bootstrap scripts", () => {
  test("Windows release bootstrap fails fast and verifies the private release asset", async () => {
    const source = await readFile("scripts/install-release.ps1", "utf8");
    expect(source).toContain("gh auth status --hostname github.com");
    expect(source).toContain("Node.js 22.12+ LTS");
    expect(source).toContain("Get-FileHash");
    expect(source).toContain("SHA256SUMS-win32-x64.json");
    expect(source).toContain("finally");
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
    expect(source).toContain("SHA256SUMS-${target}.json");
    expect(source).toContain("createHash(\"sha256\")");
    expect(source).toContain("trap 'rm -rf \"$download_directory\"' EXIT");
  });
});

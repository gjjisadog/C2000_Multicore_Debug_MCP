import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { assertAllowedReadPath, assertAllowedWritePath, validateToolPaths, withAdditionalReadRoots } from "../src/security/pathPolicy.js";

describe("filesystem path policy", () => {
  test("allows configured reads and writes and rejects escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-path-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "c2000-path-outside-"));
    const file = path.join(root, "image.out");
    await writeFile(file, "image");
    await expect(assertAllowedReadPath(file, { allowedReadRoots: [root], allowedWriteRoots: [root] })).resolves.toBe(await realpath(file));
    await expect(assertAllowedWritePath(path.join(root, "bundle", "summary.md"), { allowedReadRoots: [root], allowedWriteRoots: [root] })).resolves.toContain(root);
    await expect(assertAllowedReadPath(path.join(root, "..", path.basename(outside), "secret.out"), { allowedReadRoots: [root], allowedWriteRoots: [root] })).rejects.toMatchObject({ code: "PathOutsideAllowedReadRoots" });
  });

  test("rejects symlink escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-path-link-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "c2000-path-target-"));
    await writeFile(path.join(outside, "secret.out"), "secret");
    await mkdir(path.join(root, "links"));
    try {
      await symlink(outside, path.join(root, "links", "outside"));
    } catch (error) {
      // Windows requires Developer Mode or elevated privileges for symlinks.
      if (isSymlinkPermissionError(error)) return;
      throw error;
    }
    await expect(assertAllowedReadPath(path.join(root, "links", "outside", "secret.out"), { allowedReadRoots: [root], allowedWriteRoots: [] })).rejects.toMatchObject({ code: "PathOutsideAllowedReadRoots" });
  });

  test("does not validate program artifacts for an explicitly non-loading core", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-path-disabled-load-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "c2000-path-disabled-load-outside-"));
    const policy = { allowedReadRoots: [root], allowedWriteRoots: [root] };
    const programUri = path.join(outside, "cpu2.out");
    const mapUri = path.join(outside, "cpu2.map");

    await expect(validateToolPaths({
      cores: [{ coreId: 2, load: false, programUri, mapUri }]
    }, policy)).resolves.toBeUndefined();

    await expect(validateToolPaths({
      cores: [{ coreId: 2, load: true, programUri, mapUri }]
    }, policy)).rejects.toMatchObject({ code: "PathOutsideAllowedReadRoots" });
  });

  test("allows configured toolchain and firmware roots while rejecting unrelated paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-path-configured-root-"));
    const toolchainRoot = await mkdtemp(path.join(os.tmpdir(), "c2000-path-toolchain-"));
    const firmwareRoot = await mkdtemp(path.join(os.tmpdir(), "c2000-path-firmware-"));
    const ccxmlPath = path.join(toolchainRoot, "targetConfigs", "board.ccxml");
    await mkdir(path.dirname(ccxmlPath), { recursive: true });
    await writeFile(ccxmlPath, "<configurations />");

    const policy = withAdditionalReadRoots(
      { allowedReadRoots: [root], allowedWriteRoots: [] },
      { roots: [toolchainRoot, firmwareRoot], files: [ccxmlPath] }
    );

    await expect(validateToolPaths({
      ccsInstallPath: toolchainRoot,
      ccxmlPath,
      searchRoots: [firmwareRoot]
    }, policy)).resolves.toBeUndefined();

    await expect(validateToolPaths({
      searchRoots: [path.join(os.tmpdir(), "c2000-path-unrelated")]
    }, policy)).rejects.toMatchObject({ code: "PathOutsideAllowedReadRoots" });
  });
});

function isSymlinkPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ["EPERM", "EACCES"].includes(String((error as { code?: unknown }).code));
}

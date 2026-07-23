import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { normalizeProgramUri } from "../src/utils/pathUtils.js";

describe("normalizeProgramUri", () => {
  test("trims surrounding quotes", () => {
    expect(normalizeProgramUri(`"/tmp/cpu1.out"`)).toBe("/tmp/cpu1.out");
    expect(normalizeProgramUri(`'/tmp/cpu2.out'`)).toBe("/tmp/cpu2.out");
  });

  test("converts file:// URLs to filesystem paths", () => {
    const absolute = path.resolve("/tmp/cpu1.out");
    expect(normalizeProgramUri(pathToFileURL(absolute).href)).toBe(absolute);
  });

  test("expands home directory prefix", () => {
    expect(normalizeProgramUri("~/workspace/cpu1.out")).toBe(path.join(os.homedir(), "workspace/cpu1.out"));
  });

  test("resolves relative paths against process.cwd()", () => {
    expect(normalizeProgramUri("out/cpu1.out")).toBe(path.resolve("out/cpu1.out"));
  });

  test("resolves relative paths against workspace baseDir when provided", () => {
    const workspace = path.resolve("/tmp/workspace_ccs");
    expect(normalizeProgramUri("cpu1/Debug/cpu1.out", workspace)).toBe(
      path.join(workspace, "cpu1/Debug/cpu1.out")
    );
  });
});

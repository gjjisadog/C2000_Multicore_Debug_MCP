import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  discoverCcsInstallCandidates,
  resolveCcsInstallPath,
  scoreCcsInstallPath,
  sortCcsInstallCandidates
} from "../src/adapters/ccsInstallPath.js";

describe("ccs install path discovery", () => {
  test("scores higher CCS product versions first", () => {
    expect(scoreCcsInstallPath("/Applications/ti/ccs2100/ccs")).toBeGreaterThan(
      scoreCcsInstallPath("/Applications/ti/ccs1281/ccs")
    );
    expect(scoreCcsInstallPath("/Applications/ti/ccs21.0/ccs")).toBeGreaterThan(
      scoreCcsInstallPath("/Applications/ti/ccs1281/ccs")
    );
    const sorted = sortCcsInstallCandidates([
      "/Applications/ti/ccs1281/ccs",
      "/Applications/ti/ccs2100/ccs",
      "/Applications/ti/ccs2000/ccs"
    ]);
    expect(sorted[0]).toContain("ccs2100");
  });

  test("discovers nested ccs product trees under a search root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2000-ccs-root-"));
    const oldInstall = path.join(root, "ccs1281", "ccs");
    const newInstall = path.join(root, "ccs21.0", "ccs");
    for (const install of [oldInstall, newInstall]) {
      const bin = path.join(install, "ccs_base", "scripting", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, process.platform === "win32" ? "dss.bat" : "dss.sh"), "#!/bin/sh\n");
    }

    const candidates = await discoverCcsInstallCandidates([root]);
    expect(candidates[0]).toBe(path.resolve(newInstall));
    expect(candidates).toEqual(expect.arrayContaining([
      path.resolve(oldInstall),
      path.resolve(newInstall)
    ]));

    const resolved = await resolveCcsInstallPath({ searchRoots: [root], envInstallPath: "" });
    expect(resolved.source).toBe("discovered");
    expect(resolved.installPath).toBe(path.resolve(newInstall));
  });

  test("explicit installPath wins over discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2000-ccs-explicit-"));
    const install = path.join(root, "ccs2100", "ccs");
    const bin = path.join(install, "ccs_base", "scripting", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, process.platform === "win32" ? "dss.bat" : "dss.sh"), "#!/bin/sh\n");

    const explicit = path.join(root, "custom-ccs");
    const resolved = await resolveCcsInstallPath({
      installPath: explicit,
      searchRoots: [root]
    });
    expect(resolved.source).toBe("explicit");
    expect(resolved.installPath).toBe(path.resolve(explicit));
  });
});

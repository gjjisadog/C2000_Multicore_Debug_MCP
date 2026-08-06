import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveTiEnvironment } from "../src/config/tiPaths.js";

async function createCcs(root: string, folder: string) {
  const ccsPath = path.join(root, "ti", folder, "ccs");
  await mkdir(path.join(ccsPath, "ccs_base", "DebugServer", "bin"), { recursive: true });
  await writeFile(path.join(ccsPath, "ccs_base", "DebugServer", "bin", "DSLite"), "");
  return ccsPath;
}

async function createC2000Ware(root: string, folder: string, version: string) {
  const warePath = path.join(root, "ti", "c2000", folder);
  const targetConfigDir = path.join(warePath, "device_support", "f28p65x", "common", "targetConfigs");
  await mkdir(path.join(warePath, ".metadata"), { recursive: true });
  await mkdir(targetConfigDir, { recursive: true });
  await writeFile(path.join(warePath, ".metadata", "sdk.json"), JSON.stringify({ version }));
  const ccxmlPath = path.join(targetConfigDir, "TMS320F28P650DK9.ccxml");
  await writeFile(ccxmlPath, "<configurations/>");
  return { warePath, ccxmlPath };
}

describe("resolveTiEnvironment", () => {
  test("uses explicit validated paths before newer discovered installations", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "c2000-paths-explicit-"));
    const explicitCcs = await createCcs(homeDir, "ccs2050");
    const explicitWare = await createC2000Ware(homeDir, "C2000Ware_6_00_01_00", "6.00.01.00");
    await createCcs(homeDir, "ccs2100");
    await createC2000Ware(homeDir, "C2000Ware_26_01_00_00", "26.01.00.00");

    const result = await resolveTiEnvironment({
      homeDir,
      ccsInstallPath: explicitCcs,
      c2000WarePath: explicitWare.warePath,
      ccxmlPath: explicitWare.ccxmlPath
    });

    expect(result.ccs).toMatchObject({ path: explicitCcs, source: "explicit", valid: true });
    expect(result.c2000Ware).toMatchObject({ path: explicitWare.warePath, version: "6.00.01.00", source: "explicit", valid: true });
    expect(result.ccxml).toMatchObject({ path: explicitWare.ccxmlPath, source: "explicit", valid: true });
  });

  test("discovers and selects the newest valid CCS and C2000Ware under the user home", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "c2000-paths-discovery-"));
    await createCcs(homeDir, "ccs2050");
    const newestCcs = await createCcs(homeDir, "ccs21.0");
    await createC2000Ware(homeDir, "C2000Ware_6_00_01_00", "6.00.01.00");
    const newestWare = await createC2000Ware(homeDir, "C2000Ware_26_01_00_00", "26.01.00.00");

    const result = await resolveTiEnvironment({ homeDir, applicationRoots: [] });

    expect(result.ccs).toMatchObject({ path: newestCcs, version: "21.0.0", source: "discovered", valid: true });
    expect(result.c2000Ware).toMatchObject({ path: newestWare.warePath, version: "26.01.00.00", source: "discovered", valid: true });
    expect(result.ccxml).toMatchObject({ path: newestWare.ccxmlPath, source: "derived", valid: true });
  });

  test("reports rejected candidates and leaves invalid explicit paths unresolved", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "c2000-paths-invalid-"));
    const missingCcs = path.join(homeDir, "missing-ccs");
    const invalidWare = path.join(homeDir, "ti", "c2000", "C2000Ware_99_00_00_00");
    await mkdir(invalidWare, { recursive: true });

    const result = await resolveTiEnvironment({
      homeDir,
      applicationRoots: [],
      ccsInstallPath: missingCcs,
      c2000WarePath: invalidWare
    });

    expect(result.ccs).toMatchObject({ path: undefined, source: "unresolved", valid: false });
    expect(result.c2000Ware).toMatchObject({ path: undefined, source: "unresolved", valid: false });
    expect(result.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ccs", path: missingCcs, valid: false, reason: "Missing CCS DSLite anchor" }),
      expect.objectContaining({ kind: "c2000ware", path: invalidWare, valid: false, reason: "Missing C2000Ware sdk.json anchor" })
    ]));
  });
});

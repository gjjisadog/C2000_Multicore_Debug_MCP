import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { discoverAcceptancePrograms, validateProgramPair } from "../src/hardware/programDiscovery.js";

describe("hardware acceptance program discovery", () => {
  test("uses explicit CPU program paths before scanning roots", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-program-discovery-"));
    const explicitCpu1 = path.join(tempDir, "explicit-cpu1.out");
    const explicitCpu2 = path.join(tempDir, "explicit-cpu2.out");
    await writeFile(explicitCpu1, "cpu1");
    await writeFile(explicitCpu2, "cpu2");

    const result = await discoverAcceptancePrograms({
      cpu1Program: explicitCpu1,
      cpu2Program: explicitCpu2,
      searchRoots: [tempDir]
    });

    expect(result.cpu1.selected).toBe(explicitCpu1);
    expect(result.cpu1.source).toBe("env");
    expect(result.cpu2.selected).toBe(explicitCpu2);
    expect(result.cpu2.source).toBe("env");
    expect(result.pairing).toEqual(expect.objectContaining({ complete: true, compatible: true, issues: [] }));
  });

  test("discovers CPU1 and CPU2 .out files from search roots when env paths are missing", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-program-discovery-"));
    const cpu1Dir = path.join(tempDir, "hybrid30k_f28p65x_ipc_cpu1", "CPU1_RAM");
    const cpu2Dir = path.join(tempDir, "hybrid30k_f28p65x_ipc_cpu2", "CPU2_RAM");
    await mkdir(cpu1Dir, { recursive: true });
    await mkdir(cpu2Dir, { recursive: true });
    const cpu1Out = path.join(cpu1Dir, "hybrid30k_f28p65x_ipc_cpu1.out");
    const cpu2Out = path.join(cpu2Dir, "hybrid30k_f28p65x_ipc_cpu2.out");
    await writeFile(cpu1Out, "cpu1");
    await writeFile(cpu2Out, "cpu2");

    const result = await discoverAcceptancePrograms({
      searchRoots: [tempDir]
    });

    expect(result.cpu1.selected).toBe(cpu1Out);
    expect(result.cpu1.source).toBe("discovered");
    expect(result.cpu1.candidates).toContain(cpu1Out);
    expect(result.cpu2.selected).toBe(cpu2Out);
    expect(result.cpu2.source).toBe("discovered");
    expect(result.cpu2.candidates).toContain(cpu2Out);
    expect(result.pairing).toEqual(expect.objectContaining({
      compatible: true,
      cpu1: expect.objectContaining({ device: "f28p65x", configuration: "RAM", core: "cpu1" }),
      cpu2: expect.objectContaining({ device: "f28p65x", configuration: "RAM", core: "cpu2" })
    }));
  });

  test("returns unresolved entries instead of guessing when no matching .out exists", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-program-discovery-"));
    await writeFile(path.join(tempDir, "generic.out"), "generic");

    const result = await discoverAcceptancePrograms({
      searchRoots: [tempDir]
    });

    expect(result.cpu1.selected).toBeUndefined();
    expect(result.cpu1.source).toBe("missing");
    expect(result.cpu2.selected).toBeUndefined();
    expect(result.cpu2.source).toBe("missing");
    expect(result.pairing).toEqual(expect.objectContaining({ complete: false, compatible: false }));
  });

  test("selects a compatible device pair instead of independently taking mismatched top candidates", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-program-pairing-"));
    const paths = [
      path.join(tempDir, "a_f28374s", "CPU1_RAM", "ipc_ex1_c28x1.out"),
      path.join(tempDir, "b_f28p65x", "CPU1_RAM", "ipc_ex1_c28x1.out"),
      path.join(tempDir, "b_f28p65x", "CPU2_RAM", "ipc_ex1_c28x2.out")
    ];
    for (const artifact of paths) {
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, "image");
    }

    const result = await discoverAcceptancePrograms({ searchRoots: [tempDir] });

    expect(result.cpu1.selected).toBe(paths[1]);
    expect(result.cpu2.selected).toBe(paths[2]);
    expect(result.pairing).toEqual(expect.objectContaining({ compatible: true }));
  });

  test("does not join outputs from different builds and requires a choice between complete builds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2000-program-builds-"));
    try {
      const oldCpu1 = path.join(root, "old", "ipc_cpu1", "CPU1_RAM", "ipc_cpu1.out");
      const oldCpu2 = path.join(root, "old", "ipc_cpu2", "CPU2_RAM", "ipc_cpu2.out");
      const newCpu1 = path.join(root, "new", "ipc_cpu1", "CPU1_RAM", "ipc_cpu1.out");
      const newCpu2 = path.join(root, "new", "ipc_cpu2", "CPU2_RAM", "ipc_cpu2.out");
      for (const output of [oldCpu1, newCpu2]) {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, "image");
      }
      const mixed = await discoverAcceptancePrograms({ searchRoots: [root] });
      expect(mixed).toMatchObject({ pairing: { compatible: false }, selectionIssue: expect.stringContaining("shares a build directory") });
      expect(mixed.cpu1.selected).toBeUndefined();
      expect(mixed.cpu2.selected).toBeUndefined();

      await mkdir(path.dirname(oldCpu2), { recursive: true });
      await writeFile(oldCpu2, "image");
      expect(await discoverAcceptancePrograms({ searchRoots: [root] })).toMatchObject({
        cpu1: { selected: oldCpu1 }, cpu2: { selected: oldCpu2 }, pairing: { compatible: true }
      });

      await mkdir(path.dirname(newCpu1), { recursive: true });
      await writeFile(newCpu1, "image");
      const ambiguous = await discoverAcceptancePrograms({ searchRoots: [root] });
      expect(ambiguous).toMatchObject({ selectionIssue: expect.stringContaining("Multiple compatible"), pairing: { compatible: false } });
      expect(ambiguous.cpu1.candidates).toEqual(expect.arrayContaining([oldCpu1, newCpu1]));
      expect(ambiguous.cpu2.candidates).toEqual(expect.arrayContaining([oldCpu2, newCpu2]));

      const partial = await discoverAcceptancePrograms({ searchRoots: [root], cpu1Program: newCpu1 });
      expect(partial).toMatchObject({ cpu1: { selected: newCpu1 }, cpu2: { selected: newCpu2 }, pairing: { compatible: true } });
      const explicit = await discoverAcceptancePrograms({ searchRoots: [root], cpu1Program: oldCpu1, cpu2Program: oldCpu2 });
      expect(explicit).toMatchObject({ cpu1: { selected: oldCpu1 }, cpu2: { selected: oldCpu2 }, pairing: { compatible: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports explicit RAM/FLASH and device mismatches", async () => {
    const result = await discoverAcceptancePrograms({
      cpu1Program: "C:/build/f28p65x/ipc_ex1_c28x1/CPU1_RAM/ipc_ex1_c28x1.out",
      cpu2Program: "C:/build/f28374s/ipc_ex1_c28x2/CPU2_FLASH/ipc_ex1_c28x2.out"
    });

    expect(result.pairing).toEqual(expect.objectContaining({
      complete: true,
      compatible: false,
      issues: expect.arrayContaining([
        expect.stringContaining("device mismatch"),
        expect.stringContaining("configuration mismatch"),
        expect.stringContaining("does not match expected")
      ])
    }));
  });

  test.each(["F28P650DK8", "F28P650DK9", "TMS320F28P650DK9"])("discovers a compatible %s image pair for F28P65x", async (device) => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-program-pairing-"));
    try {
      const cpu1 = path.join(tempDir, device, "CPU1_RAM", "ipc_ex1_c28x1.out");
      const cpu2 = path.join(tempDir, device, "CPU2_RAM", "ipc_ex1_c28x2.out");
      for (const artifact of [cpu1, cpu2]) {
        await mkdir(path.dirname(artifact), { recursive: true });
        await writeFile(artifact, "image");
      }

      const result = await discoverAcceptancePrograms({ searchRoots: [tempDir] });
      expect(result.cpu1.selected).toBe(cpu1);
      expect(result.cpu2.selected).toBe(cpu2);
      const deviceId = device.toLowerCase().replace(/^tms320/, "");
      expect(result.pairing).toMatchObject({ complete: true, compatible: true, issues: [],
        cpu1: { device: deviceId }, cpu2: { device: deviceId } });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects known different models within the F28P65x family", () => {
    const result = validateProgramPair("F28P650DK8/cpu1.out", "F28P650DK9/cpu2.out", "F28P65x");
    expect(result).toMatchObject({
      compatible: false,
      issues: ["CPU1/CPU2 device mismatch: f28p650dk8 vs f28p650dk9"]
    });
  });

  test("accepts profile-qualified CPU1/CPU2 companion artifacts from the same build family", async () => {
    const result = await discoverAcceptancePrograms({
      cpu1Program: "C:/build/Hybrid30K_CPU1_DK9_RUNTIME_ACCEPTANCE_RAM.out",
      cpu2Program: "C:/build/Hybrid30K_CPU2_DK9_CE_PRELOADED_VALIDATION_RAM.out"
    });

    expect(result.pairing).toEqual(expect.objectContaining({
      compatible: true,
      issues: [],
      cpu1: expect.objectContaining({ pairKey: "hybrid30k" }),
      cpu2: expect.objectContaining({ pairKey: "hybrid30k" })
    }));
  });
});

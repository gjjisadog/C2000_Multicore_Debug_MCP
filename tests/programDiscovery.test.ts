import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { discoverAcceptancePrograms } from "../src/hardware/programDiscovery.js";

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
});

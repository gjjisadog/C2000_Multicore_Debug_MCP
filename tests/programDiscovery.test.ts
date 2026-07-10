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
  });
});

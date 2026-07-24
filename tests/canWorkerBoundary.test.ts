import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("CAN worker native boundary", () => {
  test("keeps PCAN native adapter imports out of the daemon", async () => {
    const source = await readFile(new URL("../src/daemon/DebugDaemon.ts", import.meta.url), "utf8");
    expect(source).toContain("CanWorkerProcess");
    expect(source).not.toContain("PcanBasicCanBusAdapter");
    expect(source).not.toContain("PcanBasicNativeDriver");
    expect(source).not.toContain("koffi");
  });
});

import { describe, expect, test } from "vitest";
import { createStartupDiagnostics, createStartupStageRunner } from "../src/debug/startupStageDiagnostics.js";
import { DebugMcpError } from "../src/utils/errors.js";

describe("debug startup stage diagnostics", () => {
  test("records completed stages and target-access intent", async () => {
    const diagnostics = createStartupDiagnostics();
    const runStage = createStartupStageRunner(diagnostics);

    await expect(runStage("dss-startup", async () => "ready", { targetAccessAttempted: false })).resolves.toBe("ready");

    expect(diagnostics).toEqual(expect.objectContaining({
      schemaVersion: 1,
      targetAccessAttempted: false,
      stages: [expect.objectContaining({
        stage: "dss-startup",
        status: "completed",
        targetAccessAttempted: false,
        durationMs: expect.any(Number)
      })]
    }));
  });

  test("adds stage context without making nested diagnostics circular", async () => {
    const diagnostics = createStartupDiagnostics();
    const runStage = createStartupStageRunner(diagnostics);

    await expect(runStage("probe-preparation", () => runStage("probe-preflight", async () => {
      throw new DebugMcpError("ProbeNotConnected", "XDS110 is not available", { probeId: "board-01" });
    }))).rejects.toMatchObject({
      code: "ProbeNotConnected",
      details: expect.objectContaining({
        startupStage: "probe-preparation",
        startupDiagnostics: expect.any(Object)
      })
    });

    expect(diagnostics.stages).toEqual([
      expect.objectContaining({ stage: "probe-preflight", status: "failed", error: expect.objectContaining({ code: "ProbeNotConnected" }) }),
      expect.objectContaining({ stage: "probe-preparation", status: "failed", error: expect.objectContaining({ code: "ProbeNotConnected" }) })
    ]);
    expect(() => JSON.stringify(diagnostics)).not.toThrow();
  });

  test("normalizes an unstructured startup failure so callers still get stage evidence", async () => {
    const diagnostics = createStartupDiagnostics();
    const runStage = createStartupStageRunner(diagnostics);

    await expect(runStage("dss-startup", async () => {
      throw new Error("DSS process exited before handshake");
    })).rejects.toMatchObject({
      code: "StartupStageFailed",
      details: expect.objectContaining({
        startupStage: "dss-startup",
        cause: { code: "UnknownError", message: "DSS process exited before handshake" }
      })
    });
  });
});

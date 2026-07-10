import { describe, expect, test } from "vitest";
import { assertRunPauseAcceptanceSummary, buildRunPauseAcceptanceSummary } from "../src/debug/runPauseAcceptance.js";

describe("run/pause acceptance summary", () => {
  test("maps the four hardware acceptance criteria to explicit per-core steps", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ]);

    expect(summary.success).toBe(true);
    expect(summary.acceptanceCriteria).toEqual([
      {
        requirement: "c2000_continue({ sessionId, coreId: 0 }) only runs CPU1",
        label: "c2000_continue(cpu1)",
        targetCoreId: 0,
        peerCoreIds: [2],
        expectedTargetState: "Running"
      },
      {
        requirement: "c2000_continue({ sessionId, coreId: 2 }) only runs CPU2",
        label: "c2000_continue(cpu2)",
        targetCoreId: 2,
        peerCoreIds: [0],
        expectedTargetState: "Running"
      },
      {
        requirement: "c2000_pause({ sessionId, coreId: 0 }) only pauses CPU1",
        label: "c2000_pause(cpu1)",
        targetCoreId: 0,
        peerCoreIds: [2],
        expectedTargetState: "Halted"
      },
      {
        requirement: "c2000_pause({ sessionId, coreId: 2 }) only pauses CPU2",
        label: "c2000_pause(cpu2)",
        targetCoreId: 2,
        peerCoreIds: [0],
        expectedTargetState: "Halted"
      }
    ]);
    expect(summary.steps).toContainEqual(expect.objectContaining({
      label: "c2000_continue(cpu1)",
      checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
    }));
    expect(summary.steps).toContainEqual(expect.objectContaining({
      label: "c2000_pause(cpu2)",
      checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
    }));
  });

  test("does not mark acceptance successful when a step reports the wrong target core", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ]);

    expect(summary.success).toBe(false);
    expect(summary.steps.find(step => step.label === "c2000_continue(cpu1)")).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining(["targetCoreId expected 0, got 2"])
    }));
  });

  test("includes structured command errors in failed acceptance summary steps", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: {
          success: false,
          error: {
            code: "UnknownError",
            message: "run failed on CPU1"
          }
        },
        assertion: {
          success: false,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: ["command failed: run failed on CPU1"]
        }
      },
      {
        label: "c2000_pause(cpu1)",
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ] as any);

    expect(summary.steps.find(step => step.label === "c2000_continue(cpu1)")).toEqual(expect.objectContaining({
      success: false,
      commandError: {
        code: "UnknownError",
        message: "run failed on CPU1"
      }
    }));
  });

  test("does not mark acceptance successful when a command result reports the wrong core", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: {
          success: true,
          coreId: 2,
          coreName: "C28xx_CPU2"
        },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        commandResult: {
          success: true,
          coreId: 0,
          coreName: "C28xx_CPU1"
        },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        commandResult: {
          success: true,
          coreId: 2,
          coreName: "C28xx_CPU2"
        },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        commandResult: {
          success: true,
          coreId: 2,
          coreName: "C28xx_CPU2"
        },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ] as any);

    expect(summary.success).toBe(false);
    expect(summary.steps.find(step => step.label === "c2000_continue(cpu1)")).toEqual(expect.objectContaining({
      success: false,
      commandCoreId: 2,
      commandCoreName: "C28xx_CPU2",
      failures: expect.arrayContaining(["commandCoreId expected 0, got 2"])
    }));
  });

  test("does not mark acceptance successful when a command result omits core identity", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: { success: true },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        commandResult: {
          success: true,
          coreId: 0,
          coreName: "C28xx_CPU1"
        },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        commandResult: {
          success: true,
          coreId: 2,
          coreName: "C28xx_CPU2"
        },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        commandResult: {
          success: true,
          coreId: 2,
          coreName: "C28xx_CPU2"
        },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ] as any);

    expect(summary.success).toBe(false);
    expect(summary.steps.find(step => step.label === "c2000_continue(cpu1)")).toEqual(expect.objectContaining({
      success: false,
      failures: expect.arrayContaining(["command core identity missing"])
    }));
  });

  test("does not mark acceptance successful when a command result reports the wrong core name", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: {
          success: true,
          coreId: 0,
          coreName: "C28xx_CPU2"
        },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ]);

    expect(summary.success).toBe(false);
    expect(summary.steps.find(step => step.label === "c2000_continue(cpu1)")).toEqual(expect.objectContaining({
      success: false,
      commandCoreId: 0,
      commandCoreName: "C28xx_CPU2",
      failures: expect.arrayContaining(["commandCoreName expected C28xx_CPU1, got C28xx_CPU2"])
    }));
  });

  test("requires successful acceptance summaries to include matching command core identity", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ]);
    const malformed = {
      ...summary,
      steps: summary.steps.map(step => step.label === "c2000_continue(cpu1)"
        ? { ...step, commandCoreId: 2, commandCoreName: "C28xx_CPU2" }
        : step)
    };

    expect(() => assertRunPauseAcceptanceSummary(malformed)).toThrow(/commandCoreId/);
  });

  test("requires successful acceptance summaries to include the expected command core name", () => {
    const summary = buildRunPauseAcceptanceSummary([
      {
        label: "c2000_continue(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Running",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu1)",
        commandResult: { success: true, coreId: 0, coreName: "C28xx_CPU1" },
        assertion: {
          success: true,
          targetCoreId: 0,
          expectedTargetState: "Halted",
          peerCoreIds: [2],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_continue(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Running",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      },
      {
        label: "c2000_pause(cpu2)",
        commandResult: { success: true, coreId: 2, coreName: "C28xx_CPU2" },
        assertion: {
          success: true,
          targetCoreId: 2,
          expectedTargetState: "Halted",
          peerCoreIds: [0],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
          failures: []
        }
      }
    ]);
    const malformed = {
      ...summary,
      steps: summary.steps.map(step => step.label === "c2000_continue(cpu1)"
        ? { ...step, commandCoreName: "C28xx_CPU2" }
        : step)
    };

    expect(() => assertRunPauseAcceptanceSummary(malformed)).toThrow(/commandCoreName/);
  });
});

import { describe, expect, test } from "vitest";
import { assertCoreIsolation } from "../src/debug/isolationAssertions.js";
import type { CoreSnapshot, LoadedProgramInfo } from "../src/debug/types.js";

const cpu1ProgramInfo: LoadedProgramInfo = {
  sessionId: "dbg-1",
  coreId: 0,
  coreName: "C28xx_CPU1",
  programUri: "cpu1.out",
  loadedAt: "2026-07-08T00:00:00.000Z",
  fileMTime: "2026-07-08T00:00:00.000Z",
  fileSize: 100,
  sha256: "1".repeat(64),
  symbolsLoaded: true,
  warning: ""
};

const cpu2ProgramInfo: LoadedProgramInfo = {
  sessionId: "dbg-1",
  coreId: 2,
  coreName: "C28xx_CPU2",
  programUri: "cpu2.out",
  loadedAt: "2026-07-08T00:00:00.000Z",
  fileMTime: "2026-07-08T00:00:00.000Z",
  fileSize: 200,
  sha256: "2".repeat(64),
  symbolsLoaded: true,
  warning: ""
};

const haltedCpu1: CoreSnapshot = {
  coreId: 0,
  coreName: "C28xx_CPU1",
  name: "C28xx_CPU1",
  connected: true,
  state: "Halted",
  pc: "0x00001000",
  loadedProgram: "cpu1.out",
  loadedProgramInfo: cpu1ProgramInfo
};

const haltedCpu2: CoreSnapshot = {
  coreId: 2,
  coreName: "C28xx_CPU2",
  name: "C28xx_CPU2",
  connected: true,
  state: "Halted",
  pc: "0x00002000",
  loadedProgram: "cpu2.out",
  loadedProgramInfo: cpu2ProgramInfo
};

describe("assertCoreIsolation", () => {
  test("accepts a transition where only the requested core changes state", () => {
    const assertion = assertCoreIsolation({
      label: "c2000_continue(cpu1)",
      before: { sessionId: "dbg-1", cores: [haltedCpu1, haltedCpu2] },
      after: {
        sessionId: "dbg-1",
        cores: [{ ...haltedCpu1, state: "Running" }, haltedCpu2]
      },
      targetCoreId: 0,
      expectedTargetState: "Running"
    });

    expect(assertion).toEqual({
      label: "c2000_continue(cpu1)",
      targetCoreId: 0,
      expectedTargetState: "Running",
      peerCoreIds: [2],
      checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
      success: true
    });
  });

  test("throws when the requested core does not reach the expected state", () => {
    expect(() => assertCoreIsolation({
      label: "c2000_continue(cpu1)",
      before: { sessionId: "dbg-1", cores: [haltedCpu1, haltedCpu2] },
      after: { sessionId: "dbg-1", cores: [haltedCpu1, haltedCpu2] },
      targetCoreId: 0,
      expectedTargetState: "Running"
    })).toThrow(/target core 0 state mismatch/i);
  });

  test("throws when a peer core changes state during a single-core operation", () => {
    expect(() => assertCoreIsolation({
      label: "c2000_continue(cpu1)",
      before: { sessionId: "dbg-1", cores: [haltedCpu1, haltedCpu2] },
      after: {
        sessionId: "dbg-1",
        cores: [
          { ...haltedCpu1, state: "Running" },
          { ...haltedCpu2, state: "Running" }
        ]
      },
      targetCoreId: 0,
      expectedTargetState: "Running"
    })).toThrow(/peer core 2 changed/i);
  });

  test("throws when a peer core changes loaded program metadata during a single-core operation", () => {
    expect(() => assertCoreIsolation({
      label: "c2000_continue(cpu1)",
      before: { sessionId: "dbg-1", cores: [haltedCpu1, haltedCpu2] },
      after: {
        sessionId: "dbg-1",
        cores: [
          { ...haltedCpu1, state: "Running" },
          {
            ...haltedCpu2,
            loadedProgramInfo: {
              ...cpu2ProgramInfo,
              sha256: "3".repeat(64)
            }
          }
        ]
      },
      targetCoreId: 0,
      expectedTargetState: "Running"
    })).toThrow(/peer core 2 changed fields: loadedProgramInfo/i);
  });

  test("throws when before and after snapshots are from different sessions", () => {
    expect(() => assertCoreIsolation({
      label: "c2000_continue(cpu1)",
      before: { sessionId: "dbg-1", cores: [haltedCpu1, haltedCpu2] },
      after: {
        sessionId: "dbg-2",
        cores: [{ ...haltedCpu1, state: "Running" }, haltedCpu2]
      },
      targetCoreId: 0,
      expectedTargetState: "Running"
    })).toThrow(/snapshot session mismatch/i);
  });
});

import { describe, expect, test } from "vitest";
import { ProbeRecoveryManager, type OwnedProcessIdentity } from "../src/worker/OwnedProcessLedger.js";

const owned: OwnedProcessIdentity = {
  pid: 42,
  processStartTime: "2026-01-01T00:00:00.000Z",
  probeSerial: "XDS-1",
  workerInstanceId: "worker-1",
  daemonInstanceId: "daemon-1",
  commandLineHash: "abc"
};

describe("owned DSS process recovery", () => {
  test("permits only a complete owned identity match", () => {
    const recovery = new ProbeRecoveryManager();
    expect(recovery.decide(owned, owned)).toMatchObject({ mayTerminate: true, evidence: { decision: "OWNED_MATCH" } });
    expect(recovery.decide(owned, { ...owned, processStartTime: "2026-01-02T00:00:00.000Z" })).toMatchObject({ mayTerminate: false, evidence: { decision: "PID_REUSED" } });
    expect(recovery.decide(owned, { ...owned, probeSerial: "XDS-EXTERNAL" })).toMatchObject({ mayTerminate: false, evidence: { decision: "PROBE_MISMATCH" } });
    expect(recovery.decide(owned, { ...owned, workerInstanceId: "external" })).toMatchObject({ mayTerminate: false, evidence: { decision: "EXTERNAL_OWNER" } });
  });
});

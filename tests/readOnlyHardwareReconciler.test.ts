import { describe, expect, test, vi } from "vitest";
import { ReadOnlyHardwareReconciler } from "../src/jobs/ReadOnlyHardwareReconciler.js";

describe("read-only hardware reconciliation", () => {
  test("uses a fresh session, records evidence, and never restores an old DSS session", async () => {
    const close = vi.fn(async () => undefined);
    const reconciler = new ReadOnlyHardwareReconciler({
      async inspectProbe() { return { probeSerialMatched: true, externalOwner: false }; },
      async createFreshInspectionSession() { return { sessionId: "fresh-inspection" }; },
      async inspect() {
        return {
          probe: { probeSerialMatched: true },
          cores: [{ coreId: 0, connected: true, state: "Halted", pc: "0x80000" }],
          loadedPrograms: [{ coreId: 0, sha256: "abc" }],
          safety: { safe: true, pwmTripLatched: true, contactorOpen: true },
          can: { initialized: true, busOff: false },
          faultHooks: { supported: false }
        };
      },
      close
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({
      reconciliationMode: "READ_ONLY_HARDWARE_INSPECTION",
      oldSessionRestored: false,
      newInspectionSessionCreated: true,
      decision: "SAFE_RESTART_FROM_DECLARED_BOUNDARY"
    });
    expect(close).toHaveBeenCalledWith("fresh-inspection");
  });

  test("does not create a session for an external probe owner", async () => {
    const create = vi.fn(async () => ({ sessionId: "forbidden" }));
    const reconciler = new ReadOnlyHardwareReconciler({
      async inspectProbe() { return { probeSerialMatched: true, externalOwner: true }; },
      createFreshInspectionSession: create,
      async inspect() { throw new Error("must not inspect"); },
      async close() {}
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ decision: "MANUAL_REQUIRED", newInspectionSessionCreated: false, oldSessionRestored: false });
    expect(create).not.toHaveBeenCalled();
  });
});

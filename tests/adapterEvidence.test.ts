import { describe, expect, test } from "vitest";
import { buildAdapterEvidence } from "../src/artifacts/JobArtifactSnapshotService.js";
import type { C2000McpConfig } from "../src/config/config.schema.js";

const autoConfig = { adapter: "auto", ccs: { scriptingMode: "auto" } } as C2000McpConfig;

function steps(overrides: {
  effectiveAdapterType?: "ccs" | "mock";
  sessionId?: string;
  adapterSessionId?: string;
  serial?: string;
  probeReady?: boolean;
} = {}) {
  return [
    {
      stepType: "preflight",
      output: {
        success: true,
        xdsdfu: {
          probeReady: overrides.probeReady ?? true,
          devices: [{ serialNumber: overrides.serial ?? "XDS110-TEST", name: "XDS110" }]
        }
      }
    },
    {
      stepType: "launchMulticore",
      output: {
        success: true,
        sessionId: overrides.sessionId ?? "dbg-test",
        adapterSessionId: overrides.adapterSessionId ?? "ccs-session-test",
        effectiveAdapterType: overrides.effectiveAdapterType ?? "ccs"
      }
    }
  ];
}

describe("canonical adapter evidence classification", () => {
  test("promotes auto configuration only with effective CCS session and matching physical XDS evidence", () => {
    const evidence = buildAdapterEvidence(autoConfig, "dk9", "XDS110-TEST", {
      sessionId: "dbg-test",
      adapterSessionId: "ccs-session-test"
    }, steps());

    expect(evidence).toEqual(expect.objectContaining({
      configuredAdapterMode: "auto",
      configuredScriptingMode: "auto",
      effectiveAdapterType: "ccs",
      classification: "HARDWARE_TARGET",
      provenance: expect.objectContaining({ configuredModeIsNotPromoted: true })
    }));
    expect(evidence.physicalPreflight).toEqual(expect.objectContaining({ matched: true, requestedProbeSerial: "XDS110-TEST" }));
  });

  test.each([
    ["missing session", { sessionId: undefined, adapterSessionId: undefined }],
    ["missing XDS match", { serial: "OTHER-XDS" }],
    ["probe not ready", { probeReady: false }]
  ])("fails closed for %s", (_label, overrides) => {
    const evidence = buildAdapterEvidence(autoConfig, "dk9", "XDS110-TEST", undefined, steps({
      ...overrides,
      sessionId: "",
      adapterSessionId: ""
    }));
    expect(evidence.classification).toBe("UNKNOWN");
  });

  test("keeps an actual mock session classified as MOCK", () => {
    const evidence = buildAdapterEvidence(autoConfig, "dk9", "XDS110-TEST", {
      sessionId: "mock-session",
      adapterSessionId: "mock-session"
    }, steps({ effectiveAdapterType: "mock" }));
    expect(evidence.classification).toBe("MOCK");
  });
});

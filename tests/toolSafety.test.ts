import { describe, expect, test } from "vitest";
import { c2000ToolDefinitions, definitionsForProfile } from "../src/mcp/tools.js";

describe("MCP tool safety metadata", () => {
  test("annotations never contradict effects", () => {
    for (const tool of c2000ToolDefinitions) {
      expect(tool.annotations).toBeDefined();
      if (tool.effects.includes("target-memory-write")) expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      if (tool.effects.includes("fault-injection")) expect(tool.annotations.destructiveHint, tool.name).toBe(true);
      if (tool.annotations.readOnlyHint) expect(tool.effects.some(effect => ["target-run", "target-reset", "program-load", "target-memory-write"].includes(effect))).toBe(false);
    }
  });

  test("profiles hide mutation tools", () => {
    expect(definitionsForProfile("readonly").every(tool => tool.annotations.readOnlyHint)).toBe(true);
    expect(definitionsForProfile("safe").some(tool => tool.name === "c2000_injectFaults")).toBe(false);
    expect(definitionsForProfile("full").some(tool => tool.name === "c2000_injectFaults")).toBe(true);
  });

  test("safe profile exposes guarded durable mutation without exposing direct expression writes", () => {
    const safe = definitionsForProfile("safe");
    expect(safe.some(tool => tool.name === "c2000_assignExpression")).toBe(false);
    expect(safe.some(tool => tool.name === "c2000_assignExpressions")).toBe(false);
    const submit = safe.find(tool => tool.name === "c2000_submitTestPlan");
    expect(submit).toBeDefined();
    expect(submit!.schema.safeParse({ plan: {
      planVersion: 1,
      name: "guarded-mailbox",
      boardIds: ["board-a"],
      safetyGuards: {
        conditions: [{ coreId: 0, expression: "g_trip_latched", expected: 1 }],
        haltCoreIds: [0, 2]
      },
      steps: [
        { type: "launchMulticore", loadPrograms: false },
        { type: "assignExpressions", assignments: [
          { coreId: 0, expression: "g_payload", value: 1 },
          { coreId: 0, expression: "g_nonce", value: 2 }
        ] },
        { type: "captureExpressions", reads: [{ coreId: 0, expressions: ["g_state"] }] },
        { type: "waitForExpressions", conditions: [{ coreId: 0, expression: "g_state", expected: 1 }], timeoutMs: 1000 },
        { type: "cleanup", on: "always" }
      ],
      recoveryPolicy: "manual_intervention_required"
    } }).success).toBe(true);
  });

  test("environment discovery is read-only and available in every profile", () => {
    for (const profile of ["readonly", "safe", "full"] as const) {
      const tool = definitionsForProfile(profile).find(item => item.name === "c2000_getEnvironment");
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.effects).toEqual(["host-read"]);
    }
  });

  test("server health is read-only and available in every profile", () => {
    for (const profile of ["readonly", "safe", "full"] as const) {
      const tool = definitionsForProfile(profile).find(item => item.name === "c2000_getServerHealth");
      expect(tool?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      });
      expect(tool?.effects).toEqual(["host-read"]);
    }
  });
});

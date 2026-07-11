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

  test("environment discovery is read-only and available in every profile", () => {
    for (const profile of ["readonly", "safe", "full"] as const) {
      const tool = definitionsForProfile(profile).find(item => item.name === "c2000_getEnvironment");
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.effects).toEqual(["host-read"]);
    }
  });
});

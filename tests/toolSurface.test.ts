import { describe, expect, test } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import {
  definitionsForExposure,
  definitionsForSurfaceProfile,
  getToolContracts,
  getToolExposureSummary,
  getToolSurfaceGuide,
  registerC2000Tools
} from "../src/mcp/tools.js";

function names(profile: "readonly" | "safe" | "full", surface: "agent" | "advanced" | "compatibility") {
  return new Set(definitionsForExposure(profile, surface).map(tool => tool.name));
}

describe("MCP tool surface profiles", () => {
  test("agent exposes task workflows and hides compatibility aliases and low-level controls", () => {
    const visible = names("safe", "agent");

    for (const name of [
      "c2000_getToolContracts",
      "c2000_getServerHealth",
      "c2000_getDaemonHealth",
      "c2000_getEnvironment",
      "c2000_getHardwarePreflight",
      "c2000_listBoards",
      "c2000_registerBoard",
      "c2000_recoverBoard",
      "c2000_submitTestPlan",
      "c2000_getTestRun",
      "c2000_listTestRuns",
      "c2000_cancelTestRun",
      "c2000_getTestArtifacts",
      "c2000_submitMultiBoardIpcAcceptance",
      "c2000_submitMultiBoardCanAcceptance",
      "c2000_submitCanFaultCampaign",
      "c2000_submitCanSoakTest",
      "c2000_launchAndRunIpcAcceptance",
      "c2000_runIpcAcceptance",
      "c2000_runBootHandoffDiagnosis",
      "c2000_runReloadAndDiagnose",
      "c2000_runFullDebugBundle"
    ]) {
      expect(visible, name).toContain(name);
    }

    for (const name of [
      "c2000_continue",
      "c2000_pause",
      "c2000_createDebugSession",
      "c2000_connectTarget",
      "c2000_runCore",
      "c2000_haltCore",
      "c2000_reset",
      "c2000_loadProgram",
      "c2000_assignExpressions",
      "c2000_startEradProfile"
    ]) {
      expect(visible, name).not.toContain(name);
    }
  });

  test("advanced exposes canonical atomics and observability but not aliases", () => {
    const visible = names("safe", "advanced");

    for (const name of [
      "c2000_runCore",
      "c2000_haltCore",
      "c2000_connectTarget",
      "c2000_loadProgram",
      "c2000_loadPrograms",
      "c2000_startVariableStream",
      "c2000_getVariableStreamStatus",
      "c2000_describeDlogBuffer",
      "c2000_getDlogStatus",
      "c2000_getEradCapabilities",
      "c2000_readEradProfile"
    ]) {
      expect(visible, name).toContain(name);
    }
    expect(visible).not.toContain("c2000_continue");
    expect(visible).not.toContain("c2000_pause");
  });

  test("compatibility keeps both canonical controls and historical aliases", () => {
    const visible = names("full", "compatibility");

    expect(visible).toEqual(new Set(definitionsForSurfaceProfile("compatibility").map(tool => tool.name)));
    for (const name of ["c2000_runCore", "c2000_continue", "c2000_haltCore", "c2000_pause"]) {
      expect(visible).toContain(name);
    }
  });

  test("safety remains authoritative regardless of surface", () => {
    const readonlyCompatibility = definitionsForExposure("readonly", "compatibility");
    expect(readonlyCompatibility.every(tool => tool.annotations.readOnlyHint)).toBe(true);
    expect(readonlyCompatibility.some(tool => tool.name === "c2000_reset")).toBe(false);
    expect(readonlyCompatibility.some(tool => tool.name === "c2000_loadProgram")).toBe(false);
    expect(readonlyCompatibility.some(tool => tool.name === "c2000_continue")).toBe(false);

    const safeAdvanced = definitionsForExposure("safe", "advanced");
    expect(safeAdvanced.some(tool => tool.effects.includes("fault-injection"))).toBe(false);
    expect(safeAdvanced.some(tool => tool.effects.includes("target-memory-write"))).toBe(false);

    const fullAgent = definitionsForExposure("full", "agent");
    expect(fullAgent.some(tool => tool.name === "c2000_continue")).toBe(false);
    expect(fullAgent.some(tool => tool.name === "c2000_pause")).toBe(false);
    expect(fullAgent.length).toBe(definitionsForSurfaceProfile("agent").length);
  });

  test("contracts report active exposure without embedding hidden schemas", () => {
    const summary = getToolExposureSummary("safe", "agent");
    expect(summary).toEqual(expect.objectContaining({
      profile: "safe",
      surface: "agent",
      registeredToolCount: 50,
      hiddenBySafetyCount: 8,
      hiddenBySurfaceCount: 36,
      hiddenAliases: ["c2000_continue", "c2000_pause"]
    }));

    const contracts = getToolContracts("safe", "agent");
    expect(contracts).toHaveLength(summary.registeredToolCount);
    expect(contracts.some(tool => tool.name === "c2000_continue")).toBe(false);
    expect(contracts.some(tool => tool.name === "c2000_runIpcAcceptance")).toBe(true);

    const guide = getToolSurfaceGuide("safe", "agent");
    expect(guide.surface).toBe("agent");
    expect(guide.aliases).toEqual([]);
    expect(guide.hiddenAliases).toEqual(["c2000_continue", "c2000_pause"]);
  });

  test("registered getToolContracts reports the active safety and surface profiles", async () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());

    registerC2000Tools(server, manager, {}, "safe", { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] }, {}, {}, "agent");
    const result = await handlers.get("c2000_getToolContracts")!({});

    expect(result.structuredContent).toEqual(expect.objectContaining({
      success: true,
      activeToolProfile: "safe",
      activeToolSurfaceProfile: "agent",
      surface: "agent",
      registeredToolCount: 50,
      hiddenBySafetyCount: 8,
      hiddenBySurfaceCount: 36,
      hiddenAliases: ["c2000_continue", "c2000_pause"]
    }));
  });
});

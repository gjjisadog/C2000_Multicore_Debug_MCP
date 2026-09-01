import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import {
  c2000ToolDefinitions,
  createC2000ToolInvoker,
  definitionsForExposure,
  definitionsForSurfaceProfile,
  getToolContracts,
  getToolExposureSummary,
  getToolSurfaceGuide,
  registerC2000Tools
} from "../src/mcp/tools.js";

const MAX_AGENT_TOOL_COUNT = 25;

function names(profile: "readonly" | "safe" | "full", surface: "agent" | "advanced" | "compatibility") {
  return new Set(definitionsForExposure(profile, surface).map(tool => tool.name));
}

describe("MCP tool surface profiles", () => {
  test("every emitted definition has explicit exposure and new tools fail closed to advanced", () => {
    expect(c2000ToolDefinitions.every(tool => ["default", "advanced", "compatibility"].includes(tool.exposure))).toBe(true);
    expect(c2000ToolDefinitions.find(tool => tool.name === "c2000_runIpcAcceptance")?.exposure).toBe("default");
    expect(c2000ToolDefinitions.find(tool => tool.name === "c2000_runCore")?.exposure).toBe("advanced");
    expect(c2000ToolDefinitions.find(tool => tool.name === "c2000_continue")?.exposure).toBe("compatibility");
    expect(definitionsForSurfaceProfile("agent").every(tool => tool.exposure === "default")).toBe(true);
    expect(definitionsForSurfaceProfile("advanced").every(tool => tool.exposure !== "compatibility")).toBe(true);
  });

  test("agent exposes only task-level runtime, job, workflows, focused reads, and evidence", () => {
    const visible = names("safe", "agent");
    const expected = new Set([
      "c2000_getDaemonHealth",
      "c2000_listBoards",
      "c2000_registerBoard",
      "c2000_recoverBoard",
      "c2000_submitTestPlan",
      "c2000_submitMultiBoardIpcAcceptance",
      "c2000_submitMultiBoardCanAcceptance",
      "c2000_getTestRun",
      "c2000_listTestRuns",
      "c2000_cancelTestRun",
      "c2000_getTestArtifacts",
      "c2000_getToolContracts",
      "c2000_getServerHealth",
      "c2000_getEnvironment",
      "c2000_getHardwarePreflight",
      "c2000_getSessionTopology",
      "c2000_getMulticoreSnapshot",
      "c2000_evaluateMany",
      "c2000_collectFailureBundle",
      "c2000_exportTrace",
      "c2000_launchAndRunIpcAcceptance",
      "c2000_runIpcAcceptance",
      "c2000_runBootHandoffDiagnosis",
      "c2000_runReloadAndDiagnose",
      "c2000_runFullDebugBundle"
    ]);

    expect(visible).toEqual(expected);
    expect(visible.size).toBeLessThanOrEqual(MAX_AGENT_TOOL_COUNT);
  });

  test("agent hides raw control, acceptance-audit, specialized, and observability lifecycle tools", () => {
    const visible = names("safe", "agent");
    for (const name of [
      "c2000_getDebugBoundary",
      "c2000_getAcceptanceEvidence",
      "c2000_discoverAcceptancePrograms",
      "c2000_getAcceptanceReadiness",
      "c2000_analyzeRamOwnership",
      "c2000_runEngineeringVerification",
      "c2000_createRunBaseline",
      "c2000_compareRunWithBaseline",
      "c2000_createAcceptanceClosure",
      "c2000_submitCanFaultCampaign",
      "c2000_submitCanSoakTest",
      "c2000_createDebugSession",
      "c2000_closeDebugSession",
      "c2000_connectTarget",
      "c2000_disconnectTarget",
      "c2000_runCore",
      "c2000_haltCore",
      "c2000_continue",
      "c2000_pause",
      "c2000_reset",
      "c2000_resetCores",
      "c2000_loadProgram",
      "c2000_loadPrograms",
      "c2000_loadSymbols",
      "c2000_assignExpression",
      "c2000_assignExpressions",
      "c2000_injectFaults",
      "c2000_compareExpressions",
      "c2000_waitUntilExpression",
      "c2000_waitForExpressionSet",
      "c2000_waitForIpcReady",
      "c2000_diagnoseCpu2Boot",
      "c2000_diagnoseBootHandoff",
      "c2000_launchMulticoreDebug",
      "c2000_launchMulticoreDebugSafe",
      "c2000_launchMulticoreDebugWithActions",
      "c2000_reloadResetRunToMain",
      "c2000_startVariableStream",
      "c2000_stopVariableStream",
      "c2000_getVariableStreamStatus",
      "c2000_readVariableSamples",
      "c2000_exportVariableStream",
      "c2000_describeDlogBuffer",
      "c2000_getDlogStatus",
      "c2000_readDlogBuffer",
      "c2000_exportDlog",
      "c2000_getEradCapabilities",
      "c2000_configureEradProfile",
      "c2000_startEradProfile",
      "c2000_stopEradProfile",
      "c2000_readEradProfile",
      "c2000_exportEradProfile"
    ]) {
      expect(visible, name).not.toContain(name);
    }
  });

  test("advanced exposes canonical engineering and observability tools but not aliases", () => {
    const visible = names("safe", "advanced");
    for (const name of [
      "c2000_createDebugSession",
      "c2000_connectTarget",
      "c2000_runCore",
      "c2000_haltCore",
      "c2000_reset",
      "c2000_loadProgram",
      "c2000_loadSymbols",
      "c2000_loadPrograms",
      "c2000_diagnoseCpu2Boot",
      "c2000_diagnoseBootHandoff",
      "c2000_waitUntilExpression",
      "c2000_waitForExpressionSet",
      "c2000_waitForIpcReady",
      "c2000_startVariableStream",
      "c2000_stopVariableStream",
      "c2000_getVariableStreamStatus",
      "c2000_readVariableSamples",
      "c2000_exportVariableStream",
      "c2000_describeDlogBuffer",
      "c2000_getDlogStatus",
      "c2000_readDlogBuffer",
      "c2000_exportDlog",
      "c2000_getEradCapabilities",
      "c2000_readEradProfile",
      "c2000_exportEradProfile",
      "c2000_submitCanFaultCampaign",
      "c2000_submitCanSoakTest"
    ]) {
      expect(visible, name).toContain(name);
    }
    expect(visible).not.toContain("c2000_continue");
    expect(visible).not.toContain("c2000_pause");

    const fullVisible = names("full", "advanced");
    for (const name of ["c2000_configureEradProfile", "c2000_startEradProfile", "c2000_stopEradProfile"]) {
      expect(fullVisible, name).toContain(name);
    }
  });

  test("compatibility keeps the complete historical surface and aliases", () => {
    const visible = names("full", "compatibility");

    expect(visible).toEqual(new Set(definitionsForSurfaceProfile("compatibility").map(tool => tool.name)));
    expect(visible.size).toBe(c2000ToolDefinitions.length);
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
    expect(fullAgent.length).toBe(MAX_AGENT_TOOL_COUNT);
    expect(fullAgent.some(tool => tool.name === "c2000_continue")).toBe(false);
    expect(fullAgent.some(tool => tool.name === "c2000_pause")).toBe(false);
  });

  test("contracts report active exposure and compact surface counts", () => {
    const summary = getToolExposureSummary("safe", "agent");
    expect(summary).toEqual(expect.objectContaining({
      profile: "safe",
      surface: "agent",
      registeredToolCount: 25,
      hiddenBySafetyCount: 8,
      hiddenBySurfaceCount: 61,
      advancedOnlyCount: 59,
      compatibilityOnlyCount: 2,
      hiddenAliases: ["c2000_continue", "c2000_pause"]
    }));

    const contracts = getToolContracts("safe", "agent");
    expect(contracts).toHaveLength(summary.registeredToolCount);
    expect(contracts.every(tool => tool.exposure === "default" && tool.safetyAllowed && tool.surfaceVisible)).toBe(true);
    expect(contracts.some(tool => tool.name === "c2000_continue")).toBe(false);
    expect(contracts.some(tool => tool.name === "c2000_runIpcAcceptance")).toBe(true);

    const guide = getToolSurfaceGuide("safe", "agent");
    expect(guide.surface).toBe("agent");
    expect(guide.aliases).toEqual([]);
    expect(guide.hiddenAliases).toEqual(["c2000_continue", "c2000_pause"]);
    expect(guide.advancedOnly).toBe(59);
    expect(guide.compatibilityOnly).toBe(2);
  });

  test("registered getToolContracts reports active safety, surface, and count dimensions", async () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        handlers.set(name, handler);
      }
    } as unknown as McpServerType;
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());

    registerC2000Tools(server, manager, {}, "safe", { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] }, {}, {}, "agent");
    const result = await handlers.get("c2000_getToolContracts")!({});

    expect(result.structuredContent).toEqual(expect.objectContaining({
      success: true,
      activeToolProfile: "safe",
      activeToolSurfaceProfile: "agent",
      surface: "agent",
      registeredToolCount: 25,
      hiddenBySafetyCount: 8,
      hiddenBySurfaceCount: 61,
      advancedOnlyCount: 59,
      compatibilityOnlyCount: 2,
      counts: {
        registered: 25,
        hiddenBySafety: 8,
        hiddenBySurface: 61,
        advancedOnly: 59,
        compatibilityOnly: 2
      },
      hiddenAliases: ["c2000_continue", "c2000_pause"]
    }));
  });

  test("descriptions route normal work to workflows and label advanced primitives", () => {
    const byName = new Map(c2000ToolDefinitions.map(tool => [tool.name, tool]));
    expect(byName.get("c2000_runIpcAcceptance")?.description).toContain("Preferred task-level");
    expect(byName.get("c2000_runCore")?.description).toContain("Advanced manual debug primitive");
    expect(byName.get("c2000_startVariableStream")?.description).toContain("Advanced observability tool");
    expect(byName.get("c2000_continue")?.description).toContain("Compatibility surface tool");
  });

  test("tools/list schema footprint follows the selected surface", async () => {
    async function metrics(profile: "safe" | "full", surface: "agent" | "advanced" | "compatibility") {
      const server = new McpServer({ name: "c2000-tool-surface-test", version: "test" });
      const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
      try {
        registerC2000Tools(server, manager, {}, profile, { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] }, {}, {}, surface);
        const requestHandlers = (server.server as unknown as {
          _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: unknown[] }> >;
        })._requestHandlers;
        const handler = requestHandlers.get("tools/list");
        expect(handler).toBeDefined();
        const listed = await handler!({ method: "tools/list", params: {} }, {});
        return { count: listed.tools.length, bytes: Buffer.byteLength(JSON.stringify(listed), "utf8") };
      } finally {
        await manager.disposeAllSessions();
        await server.close();
      }
    }

    const safeAgent = await metrics("safe", "agent");
    const safeAdvanced = await metrics("safe", "advanced");
    const safeCompatibility = await metrics("safe", "compatibility");
    const fullCompatibility = await metrics("full", "compatibility");

    expect(safeAgent.count).toBe(MAX_AGENT_TOOL_COUNT);
    expect(safeAgent.bytes).toBeLessThan(safeAdvanced.bytes);
    expect(safeAdvanced.bytes).toBeLessThan(safeCompatibility.bytes);
    expect(safeCompatibility.count).toBe(86);
    expect(fullCompatibility.count).toBe(94);
    expect(fullCompatibility.bytes).toBeGreaterThan(safeCompatibility.bytes);
  });

  test("hidden MCP workflows still retain backend capability", async () => {
    expect(names("safe", "agent")).not.toContain("c2000_launchMulticoreDebugSafe");
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    try {
      const invoker = createC2000ToolInvoker(manager);
      const result = await invoker.invokeTool("c2000_launchMulticoreDebugSafe", {
        sessionName: "hidden-workflow-backend-capability",
        cores: [
          { coreId: 0, coreName: "C28xx_CPU1", connect: true, load: false, haltAtEntry: true },
          { coreId: 2, coreName: "C28xx_CPU2", connect: true, load: false, haltAtEntry: true }
        ]
      });

      expect(result).toEqual(expect.objectContaining({
        success: true,
        sessionId: expect.any(String)
      }));
    } finally {
      await manager.disposeAllSessions();
    }
  });

  test("agent registration does not remove atomic capability used by task workflows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-agent-workflow-"));
    const cpu1OutPath = path.join(directory, "cpu1.out");
    const cpu2OutPath = path.join(directory, "cpu2.out");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");

    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    let sessionId: string | undefined;
    try {
      const invoker = createC2000ToolInvoker(manager);
      const created = await invoker.invokeTool("c2000_createDebugSession", {
        sessionName: "agent-surface-workflow-backend",
        coreMap: [
          { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
          { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
        ]
      });
      expect(created.success).toBe(true);
      sessionId = created.sessionId as string;
      const connected = await invoker.invokeTool("c2000_connectCores", { sessionId, coreIds: [0, 2] });
      expect(connected.success).toBe(true);

      const result = await invoker.invokeTool("c2000_runReloadAndDiagnose", {
        sessionId,
        cpu1CoreId: 0,
        cpu2CoreId: 2,
        cpu1OutPath,
        cpu2OutPath,
        ramOwnershipPolicy: "skip",
        resetType: "cpu",
        runCpu1: true,
        runCpu2: false,
        intervalMs: 1
      });

      expect(result).toEqual(expect.objectContaining({
        success: true,
        workflow: "c2000_runReloadAndDiagnose",
        cpu1CoreId: 0,
        cpu2CoreId: 2
      }));
      expect(result.performedSteps).toEqual(expect.arrayContaining([
        "haltCores",
        "resetCores",
        "loadPrograms",
        "haltCoresAfterLoad",
        "runCpu1",
        "diagnoseBootHandoff"
      ]));
    } finally {
      if (sessionId) {
        await manager.closeDebugSession(sessionId).catch(() => undefined);
      }
      await manager.disposeAllSessions();
    }
  });
});

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { c2000ToolDefinitions, createC2000ToolInvoker, getToolContracts, getToolSurfaceGuide, registerC2000Tools } from "../src/mcp/tools.js";

describe("MCP tool registration contract", () => {
  test("returns structured failures instead of rejecting tools for unknown or closed sessions", async () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    registerC2000Tools(server, manager);
    const getSessionTopology = handlers.get("c2000_getSessionTopology");
    expect(getSessionTopology).toBeDefined();

    const missing = await getSessionTopology!({ sessionId: "missing-session" });
    const created = await manager.createDebugSession({ sessionName: "closed-session" });
    await manager.closeDebugSession(created.sessionId);
    const closed = await getSessionTopology!({ sessionId: created.sessionId });

    for (const response of [missing, closed]) {
      expect(response).toEqual(expect.objectContaining({
        isError: true,
        structuredContent: expect.objectContaining({
          success: false,
          sessionId: expect.any(String),
          error: expect.objectContaining({ code: "SessionNotFound" })
        }),
        content: [expect.objectContaining({ type: "text", text: expect.stringContaining('"success": false') })]
      }));
    }
  });

  test("preserves workflow handler context through the generic tool invoker", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    try {
      const invoker = createC2000ToolInvoker(manager);
      const result = await invoker.invokeTool("c2000_launchMulticoreDebugSafe", {
        sessionName: "safe-wrapper-context",
        cores: [
          { coreId: 0, coreName: "C28xx_CPU1", connect: true, load: false, haltAtEntry: true },
          { coreId: 2, coreName: "C28xx_CPU2", connect: true, load: false, haltAtEntry: true }
        ]
      });

      expect(result).toEqual(expect.objectContaining({
        success: true,
        sessionId: expect.any(String),
        snapshot: expect.objectContaining({
          cores: expect.arrayContaining([
            expect.objectContaining({ coreId: 0, coreName: "C28xx_CPU1" }),
            expect.objectContaining({ coreId: 2, coreName: "C28xx_CPU2" })
          ])
        })
      }));
    } finally {
      await manager.disposeAllSessions();
    }
  });

  test("registers only c2000-prefixed tool names to avoid TI official MCP collisions", () => {
    const names = c2000ToolDefinitions.map(tool => tool.name);

    expect(names.every(name => name.startsWith("c2000_"))).toBe(true);
    expect(names).toEqual(expect.arrayContaining([
      "c2000_getServerHealth",
      "c2000_registerBoard",
      "c2000_createDebugSession",
      "c2000_getToolContracts",
      "c2000_getDebugBoundary",
      "c2000_getAcceptanceEvidence",
      "c2000_getHardwarePreflight",
      "c2000_discoverAcceptancePrograms",
      "c2000_getAcceptanceReadiness",
      "c2000_analyzeRamOwnership",
      "c2000_verifyBuild",
      "c2000_verifyMap",
      "c2000_verifyRegression",
      "c2000_verifyReview",
      "c2000_runEngineeringVerification",
      "c2000_getVerificationResult",
      "c2000_continue",
      "c2000_pause",
      "c2000_reset",
      "c2000_connectTarget",
      "c2000_disconnectTarget",
      "c2000_closeDebugSession",
      "c2000_getSessionTopology",
      "c2000_getTargetState",
      "c2000_loadProgram",
      "c2000_loadPrograms",
      "c2000_getMulticoreSnapshot",
      "c2000_diagnoseCpu2Boot",
      "c2000_diagnoseBootHandoff",
      "c2000_waitForIpcReady",
      "c2000_reloadResetRunToMain",
      "c2000_launchAndRunIpcAcceptance",
      "c2000_runIpcAcceptance",
      "c2000_runBootHandoffDiagnosis",
      "c2000_runReloadAndDiagnose",
      "c2000_runFullDebugBundle",
      "c2000_verifyRunPauseIsolation",
      "c2000_launchMultiBoardDebug",
      "c2000_assignExpression",
      "c2000_assignExpressions",
      "c2000_injectFaults",
      "c2000_compareExpressions",
      "c2000_waitForExpressionSet"
    ]));
  });

  test("server health is host-read and requires no target identity", () => {
    const health = c2000ToolDefinitions.find(tool => tool.name === "c2000_getServerHealth");

    expect(health).toEqual(expect.objectContaining({
      handlerName: "getServerHealth",
      inputScope: "host",
      targetEffect: "host-read",
      effects: ["host-read"]
    }));
    expect(Object.keys(health?.schema.shape ?? {})).toEqual([]);
  });

  test("does not register unprefixed debug control aliases", () => {
    const names = c2000ToolDefinitions.map(tool => tool.name);

    expect(names).not.toContain("continue");
    expect(names).not.toContain("pause");
    expect(names).not.toContain("reset");
    expect(names).not.toContain("connectTarget");
    expect(names).not.toContain("disconnectTarget");
    expect(names).not.toContain("getTargetState");
  });

  test("marks continue/pause as aliases of primary run/halt tools", () => {
    const byName = new Map(c2000ToolDefinitions.map(tool => [tool.name, tool]));
    expect(byName.get("c2000_continue")).toEqual(expect.objectContaining({
      role: "alias",
      aliasOf: "c2000_runCore",
      family: "execution"
    }));
    expect(byName.get("c2000_pause")).toEqual(expect.objectContaining({
      role: "alias",
      aliasOf: "c2000_haltCore",
      family: "execution"
    }));
    expect(byName.get("c2000_runCore")?.role).toBe("primary");
    expect(byName.get("c2000_haltCore")?.role).toBe("primary");
  });

  test("tool surface guide prefers workflows and primary atomics", () => {
    const guide = getToolSurfaceGuide();
    expect(guide.aliases).toEqual(expect.arrayContaining([
      { name: "c2000_continue", useInstead: "c2000_runCore" },
      { name: "c2000_pause", useInstead: "c2000_haltCore" }
    ]));
    expect(guide.preferredWorkflows).toEqual(expect.arrayContaining([
      "c2000_launchAndRunIpcAcceptance",
      "c2000_runIpcAcceptance",
      "c2000_runBootHandoffDiagnosis"
    ]));
    expect(guide.counts.total).toBe(c2000ToolDefinitions.length);
    expect(guide.counts.alias).toBe(2);
    expect(guide.guidance).toEqual(expect.arrayContaining([
      expect.stringContaining("c2000_registerBoard"),
      expect.stringContaining("coreId 0"),
      expect.stringContaining("allowedWriteRoots")
    ]));
  });

  test("hardware preflight is read-only and does not require sessionId or coreId", () => {
    const preflight = c2000ToolDefinitions.find(tool => tool.name === "c2000_getHardwarePreflight");

    expect(preflight).toEqual(expect.objectContaining({
      name: "c2000_getHardwarePreflight",
      handlerName: "getHardwarePreflight",
      inputScope: "host"
    }));
    expect(Object.keys(preflight?.schema.shape ?? {})).toEqual(["ccsInstallPath"]);
  });

  test("acceptance program discovery is read-only and does not require sessionId or coreId", () => {
    const discovery = c2000ToolDefinitions.find(tool => tool.name === "c2000_discoverAcceptancePrograms");

    expect(discovery).toEqual(expect.objectContaining({
      name: "c2000_discoverAcceptancePrograms",
      handlerName: "discoverAcceptancePrograms",
      inputScope: "host",
      targetEffect: "host-read"
    }));
    expect(Object.keys(discovery?.schema.shape ?? {})).toEqual(["cpu1Program", "cpu2Program", "searchRoots", "maxDepth"]);
  });

  test("acceptance readiness is read-only and does not require sessionId or coreId", () => {
    const readiness = c2000ToolDefinitions.find(tool => tool.name === "c2000_getAcceptanceReadiness");

    expect(readiness).toEqual(expect.objectContaining({
      name: "c2000_getAcceptanceReadiness",
      handlerName: "getAcceptanceReadiness",
      inputScope: "host",
      targetEffect: "host-read"
    }));
    expect(Object.keys(readiness?.schema.shape ?? {})).toEqual([
      "ccsInstallPath",
      "ccxmlPath",
      "cpu1Program",
      "cpu2Program",
      "searchRoots",
      "maxDepth",
      "allowExistingDebugProcesses",
      "waitForProbeMs",
      "probePollIntervalMs"
    ]);
  });

  test("tool contracts expose scope and required inputs to MCP clients", () => {
    const contracts = getToolContracts();

    expect(contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "c2000_getHardwarePreflight",
        inputScope: "host",
        targetEffect: "host-read",
        inputFields: ["ccsInstallPath"],
        requiredInputFields: []
      }),
      expect.objectContaining({
        name: "c2000_discoverAcceptancePrograms",
        inputScope: "host",
        targetEffect: "host-read",
        inputFields: ["cpu1Program", "cpu2Program", "searchRoots", "maxDepth"],
        requiredInputFields: []
      }),
      expect.objectContaining({
        name: "c2000_getAcceptanceReadiness",
        inputScope: "host",
        targetEffect: "host-read",
        inputFields: ["ccsInstallPath", "ccxmlPath", "cpu1Program", "cpu2Program", "searchRoots", "maxDepth", "allowExistingDebugProcesses", "waitForProbeMs", "probePollIntervalMs"],
        requiredInputFields: []
      }),
      expect.objectContaining({
        name: "c2000_analyzeRamOwnership",
        inputScope: "host",
        targetEffect: "host-read",
        inputFields: ["maps"],
        requiredInputFields: ["maps"],
        coreIdentityFields: ["maps[].coreId"],
        responseCoreIdentityFields: ["maps[].coreId", "ownershipActions[].targetCoreId"]
      }),
      expect.objectContaining({
        name: "c2000_getDebugBoundary",
        inputScope: "host",
        targetEffect: "host-read",
        inputFields: [],
        requiredInputFields: []
      }),
      expect.objectContaining({
        name: "c2000_getAcceptanceEvidence",
        inputScope: "host",
        targetEffect: "host-read",
        inputFields: [],
        requiredInputFields: []
      }),
      expect.objectContaining({
        name: "c2000_launchMultiBoardDebug",
        inputScope: "launch",
        targetEffect: "launch-workflow",
        inputFields: ["ccsInstallPath", "rollbackOnFailure", "boards"],
        requiredInputFields: ["boards"],
        coreIdentityFields: ["boards[].cores[].coreId"],
        responseCoreIdentityFields: [
          "results[].boardId",
          "results[].probeSerial",
          "results[].sessionId",
          "results[].snapshot.cores[].coreId",
          "results[].snapshot.cores[].coreName"
        ]
      }),
      expect.objectContaining({
        name: "c2000_continue",
        inputScope: "core",
        targetEffect: "execution-control",
        inputFields: expect.arrayContaining(["sessionId", "coreId"]),
        requiredInputFields: expect.arrayContaining(["sessionId", "coreId"]),
        coreIdentityFields: ["coreId"],
        responseCoreIdentityFields: ["coreId", "coreName"]
      }),
      expect.objectContaining({
        name: "c2000_loadPrograms",
        inputScope: "batch",
        targetEffect: "program-load",
        inputFields: expect.arrayContaining(["sessionId", "programs"]),
        requiredInputFields: expect.arrayContaining(["sessionId", "programs"]),
        coreIdentityFields: ["programs[].coreId"],
        responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
      }),
      expect.objectContaining({
        name: "c2000_getMulticoreSnapshot",
        inputScope: "session",
        targetEffect: "target-read",
        inputFields: expect.arrayContaining(["sessionId", "coreIds"]),
        requiredInputFields: expect.arrayContaining(["sessionId"]),
        coreIdentityFields: ["coreIds[]"],
        responseCoreIdentityFields: ["cores[].coreId", "cores[].coreName"]
      }),
      expect.objectContaining({
        name: "c2000_verifyRunPauseIsolation",
        inputScope: "session",
        targetEffect: "execution-control",
        inputFields: expect.arrayContaining(["sessionId", "cpu1CoreId", "cpu2CoreId"]),
        requiredInputFields: expect.arrayContaining(["sessionId"]),
        coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"],
        responseCoreIdentityFields: [
          "acceptanceSummary.steps[].commandCoreId",
          "acceptanceSummary.steps[].commandCoreName"
        ]
      })
    ]));
  });

  test("tool contracts classify target side effects for safe MCP clients", () => {
    const byName = new Map(getToolContracts().map(contract => [contract.name, contract]));

    expect(byName.get("c2000_getToolContracts")).toEqual(expect.objectContaining({ targetEffect: "host-read" }));
    expect(byName.get("c2000_getDebugBoundary")).toEqual(expect.objectContaining({
      inputScope: "host",
      targetEffect: "host-read",
      requiredInputFields: []
    }));
    expect(byName.get("c2000_getSessionTopology")).toEqual(expect.objectContaining({
      inputScope: "session",
      targetEffect: "session-read",
      requiredInputFields: expect.arrayContaining(["sessionId"])
    }));
    expect(byName.get("c2000_getTargetState")).toEqual(expect.objectContaining({ targetEffect: "target-read" }));
    expect(byName.get("c2000_getMulticoreSnapshot")).toEqual(expect.objectContaining({ targetEffect: "target-read" }));
    expect(byName.get("c2000_connectTarget")).toEqual(expect.objectContaining({ targetEffect: "connectivity-control" }));
    expect(byName.get("c2000_disconnectTarget")).toEqual(expect.objectContaining({ targetEffect: "connectivity-control" }));
    expect(byName.get("c2000_continue")).toEqual(expect.objectContaining({ targetEffect: "execution-control" }));
    expect(byName.get("c2000_pause")).toEqual(expect.objectContaining({ targetEffect: "execution-control" }));
    expect(byName.get("c2000_reset")).toEqual(expect.objectContaining({ targetEffect: "reset-control" }));
    expect(byName.get("c2000_loadProgram")).toEqual(expect.objectContaining({ targetEffect: "program-load" }));
    expect(byName.get("c2000_assignExpression")).toEqual(expect.objectContaining({ targetEffect: "memory-write" }));
    expect(byName.get("c2000_assignExpressions")).toEqual(expect.objectContaining({
      inputScope: "batch",
      targetEffect: "memory-write",
      requiredInputFields: expect.arrayContaining(["sessionId", "assignments"])
    }));
    expect(byName.get("c2000_injectFaults")).toEqual(expect.objectContaining({
      inputScope: "batch",
      targetEffect: "memory-write",
      requiredInputFields: expect.arrayContaining(["sessionId", "faults"])
    }));
    expect(byName.get("c2000_launchMulticoreDebug")).toEqual(expect.objectContaining({
      targetEffect: "launch-workflow",
      inputFields: expect.arrayContaining(["autoCloseOnComplete", "autoCloseIdleTimeoutMs"]),
      requiredInputFields: ["cores"]
    }));
    expect(byName.get("c2000_analyzeRamOwnership")).toEqual(expect.objectContaining({ inputScope: "host", targetEffect: "host-read" }));
    expect(byName.get("c2000_diagnoseBootHandoff")).toEqual(expect.objectContaining({ inputScope: "session", targetEffect: "target-read" }));
    expect(byName.get("c2000_waitForIpcReady")).toEqual(expect.objectContaining({ inputScope: "session", targetEffect: "target-read" }));
    expect(byName.get("c2000_reloadResetRunToMain")).toEqual(expect.objectContaining({ inputScope: "core", targetEffect: "launch-workflow" }));
    expect(byName.get("c2000_launchAndRunIpcAcceptance")).toEqual(expect.objectContaining({
      inputScope: "launch",
      targetEffect: "launch-workflow",
      inputFields: expect.arrayContaining(["autoCloseOnComplete", "autoCloseIdleTimeoutMs"])
    }));
    expect(byName.get("c2000_runIpcAcceptance")).toEqual(expect.objectContaining({ inputScope: "launch", targetEffect: "launch-workflow" }));
    expect(byName.get("c2000_runBootHandoffDiagnosis")).toEqual(expect.objectContaining({ inputScope: "launch", targetEffect: "launch-workflow" }));
    expect(byName.get("c2000_runReloadAndDiagnose")).toEqual(expect.objectContaining({ inputScope: "launch", targetEffect: "launch-workflow" }));
    expect(byName.get("c2000_runFullDebugBundle")).toEqual(expect.objectContaining({ inputScope: "launch", targetEffect: "launch-workflow" }));
    for (const name of [
      "c2000_verifyBuild",
      "c2000_verifyMap",
      "c2000_verifyRegression",
      "c2000_verifyReview",
      "c2000_runEngineeringVerification",
      "c2000_getVerificationResult"
    ]) {
      expect(byName.get(name), name).toEqual(expect.objectContaining({
        inputScope: "host",
        touchesTarget: false
      }));
    }
    expect(byName.get("c2000_verifyMap")).toEqual(expect.objectContaining({
      effects: ["host-read", "bundle-write"],
      writesHostFiles: true
    }));
    expect(byName.get("c2000_verifyReview")).toEqual(expect.objectContaining({
      effects: ["host-read", "bundle-write"],
      writesHostFiles: true
    }));
    expect(byName.get("c2000_getVerificationResult")).toEqual(expect.objectContaining({
      targetEffect: "host-read",
      effects: ["host-read"],
      writesHostFiles: false
    }));
  });

  test("target-touching tool contracts expose every per-core identity path", () => {
    const byName = new Map(getToolContracts().map(contract => [contract.name, contract]));

    const expectedCoreIdentityFields = new Map<string, string[]>([
      ["c2000_submitMultiBoardIpcAcceptance", ["ipcReadyExpressions[].coreId"]],
      ["c2000_connectTarget", ["coreId"]],
      ["c2000_disconnectTarget", ["coreId"]],
      ["c2000_runCore", ["coreId"]],
      ["c2000_continue", ["coreId"]],
      ["c2000_haltCore", ["coreId"]],
      ["c2000_pause", ["coreId"]],
      ["c2000_reset", ["coreId"]],
      ["c2000_getTargetState", ["coreId"]],
      ["c2000_loadProgram", ["coreId"]],
      ["c2000_loadPrograms", ["programs[].coreId"]],
      ["c2000_connectCores", ["coreIds[]"]],
      ["c2000_haltCores", ["coreIds[]"]],
      ["c2000_resetCores", ["coreIds[]"]],
      ["c2000_runCores", ["coreIds[]"]],
      ["c2000_getMulticoreSnapshot", ["coreIds[]"]],
      ["c2000_evaluateMany", ["coreId"]],
      ["c2000_assignExpression", ["coreId"]],
      ["c2000_assignExpressions", ["assignments[].coreId"]],
      ["c2000_injectFaults", ["faults[].coreId"]],
      ["c2000_compareExpressions", ["comparisons[].left.coreId", "comparisons[].right.coreId"]],
      ["c2000_getLoadedProgramInfo", ["coreId"]],
      ["c2000_resolvePc", ["coreId"]],
      ["c2000_resolveAddress", ["coreId"]],
      ["c2000_waitUntilExpression", ["coreId"]],
      ["c2000_waitForExpressionSet", ["conditions[].coreId"]],
      ["c2000_diagnoseCpu2Boot", ["cpu1CoreId", "cpu2CoreId"]],
      ["c2000_diagnoseBootHandoff", ["cpu1CoreId", "cpu2CoreId"]],
      ["c2000_waitForIpcReady", ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"]],
      ["c2000_reloadResetRunToMain", ["coreId"]],
      ["c2000_launchAndRunIpcAcceptance", ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"]],
      ["c2000_runIpcAcceptance", ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"]],
      ["c2000_runBootHandoffDiagnosis", ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"]],
      ["c2000_runReloadAndDiagnose", ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"]],
      ["c2000_runFullDebugBundle", ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"]],
      ["c2000_verifyRunPauseIsolation", ["cpu1CoreId", "cpu2CoreId"]],
      ["c2000_launchMulticoreDebug", [
        "cores[].coreId",
        "postLaunchActions.assignExpressions[].coreId",
        "postLaunchActions.injectFaults[].coreId",
        "postLaunchChecks.waitForExpressionSet.conditions[].coreId",
        "postLaunchChecks.compareExpressions[].left.coreId",
        "postLaunchChecks.compareExpressions[].right.coreId",
        "postLaunchChecks.diagnoseCpu2Boot.cpu1CoreId",
        "postLaunchChecks.diagnoseCpu2Boot.cpu2CoreId",
        "postLaunchChecks.verifyRunPauseIsolation.cpu1CoreId",
        "postLaunchChecks.verifyRunPauseIsolation.cpu2CoreId"
      ]]
    ]);

    for (const [name, coreIdentityFields] of expectedCoreIdentityFields) {
      expect(byName.get(name), name).toEqual(expect.objectContaining({ coreIdentityFields }));
    }

    const targetTouchingWithoutCoreIdentity = Array.from(byName.values())
      .filter(contract => !["host-read", "session-read", "session-lifecycle", "job-control"].includes(contract.targetEffect))
      .filter(contract => contract.coreIdentityFields.length === 0)
      .map(contract => contract.name);
    expect(targetTouchingWithoutCoreIdentity).toEqual([]);
  });

  test("target-touching tool contracts expose response identity paths for automated evidence", () => {
    const byName = new Map(getToolContracts().map(contract => [contract.name, contract]));

    const expectedResponseCoreIdentityFields = new Map<string, string[]>([
      ["c2000_connectTarget", ["coreId", "coreName"]],
      ["c2000_disconnectTarget", ["coreId", "coreName"]],
      ["c2000_runCore", ["coreId", "coreName"]],
      ["c2000_continue", ["coreId", "coreName"]],
      ["c2000_haltCore", ["coreId", "coreName"]],
      ["c2000_pause", ["coreId", "coreName"]],
      ["c2000_reset", ["coreId", "coreName"]],
      ["c2000_getTargetState", ["coreId", "coreName"]],
      ["c2000_loadProgram", ["coreId", "coreName"]],
      ["c2000_loadPrograms", ["results[].coreId", "results[].coreName"]],
      ["c2000_connectCores", ["results[].coreId", "results[].coreName"]],
      ["c2000_haltCores", ["results[].coreId", "results[].coreName"]],
      ["c2000_resetCores", ["results[].coreId", "results[].coreName"]],
      ["c2000_runCores", ["results[].coreId", "results[].coreName"]],
      ["c2000_getMulticoreSnapshot", ["cores[].coreId", "cores[].coreName"]],
      ["c2000_evaluateMany", ["coreId", "coreName"]],
      ["c2000_assignExpression", ["coreId", "coreName"]],
      ["c2000_assignExpressions", ["results[].coreId", "results[].coreName"]],
      ["c2000_injectFaults", ["results[].coreId", "results[].coreName"]],
      ["c2000_compareExpressions", ["comparisons[].left.coreId", "comparisons[].right.coreId"]],
      ["c2000_getLoadedProgramInfo", ["coreId", "coreName"]],
      ["c2000_resolvePc", ["coreId", "coreName"]],
      ["c2000_resolveAddress", ["coreId", "coreName"]],
      ["c2000_waitUntilExpression", ["coreId", "coreName"]],
      ["c2000_waitForExpressionSet", ["conditions[].coreId"]],
      ["c2000_diagnoseCpu2Boot", ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]],
      ["c2000_diagnoseBootHandoff", ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]],
      ["c2000_waitForIpcReady", ["conditions[].coreId"]],
      ["c2000_reloadResetRunToMain", ["coreId", "coreName"]],
      ["c2000_launchAndRunIpcAcceptance", [
        "launch.coreMap[].coreId",
        "launch.created.cores[].coreId",
        "launch.connected.results[].coreId",
        "snapshot.cores[].coreId",
        "ipcReady.conditions[].coreId",
        "diagnosis.cpu1.coreId",
        "diagnosis.cpu2.coreId",
        "diagnosis.snapshot.cores[].coreId",
        "ramOwnership.maps[].coreId"
      ]],
      ["c2000_runIpcAcceptance", [
        "snapshot.cores[].coreId",
        "ipcReady.conditions[].coreId",
        "diagnosis.cpu1.coreId",
        "diagnosis.cpu2.coreId",
        "diagnosis.snapshot.cores[].coreId",
        "ramOwnership.maps[].coreId"
      ]],
      ["c2000_runBootHandoffDiagnosis", [
        "cpu1.coreId",
        "cpu2.coreId",
        "snapshot.cores[].coreId",
        "ramOwnership.maps[].coreId",
        "expressions[].coreId",
        "pc[].coreId"
      ]],
      ["c2000_runReloadAndDiagnose", [
        "snapshot.cores[].coreId",
        "wait.conditions[].coreId",
        "diagnosis.cpu1.coreId",
        "diagnosis.cpu2.coreId",
        "diagnosis.snapshot.cores[].coreId",
        "ramOwnership.maps[].coreId"
      ]],
      ["c2000_runFullDebugBundle", [
        "snapshot.cores[].coreId",
        "loadedPrograms[].coreId",
        "expressions[].coreId",
        "pc[].coreId",
        "ramOwnership.maps[].coreId",
        "bootHandoff.cpu1.coreId",
        "bootHandoff.cpu2.coreId"
      ]],
      ["c2000_verifyRunPauseIsolation", [
        "acceptanceSummary.steps[].commandCoreId",
        "acceptanceSummary.steps[].commandCoreName"
      ]],
      ["c2000_launchMulticoreDebug", [
        "snapshot.cores[].coreId",
        "postLaunchActions.assignExpressions.results[].coreId",
        "postLaunchActions.injectFaults.results[].coreId",
        "postLaunchChecks.waitForExpressionSet.conditions[].coreId",
        "postLaunchChecks.compareExpressions.comparisons[].left.coreId",
        "postLaunchChecks.compareExpressions.comparisons[].right.coreId",
        "postLaunchChecks.diagnoseCpu2Boot.cpu1.coreId",
        "postLaunchChecks.diagnoseCpu2Boot.cpu2.coreId",
        "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreId",
        "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreName"
      ]]
    ]);

    for (const [name, responseCoreIdentityFields] of expectedResponseCoreIdentityFields) {
      expect(byName.get(name), name).toEqual(expect.objectContaining({ responseCoreIdentityFields }));
    }

    const targetTouchingWithoutResponseIdentity = Array.from(byName.values())
      .filter(contract => !["host-read", "session-read", "session-lifecycle", "job-control"].includes(contract.targetEffect))
      .filter(contract => contract.responseCoreIdentityFields.length === 0)
      .map(contract => contract.name);
    expect(targetTouchingWithoutResponseIdentity).toEqual([]);
  });

  test("debug control tool definitions declare explicit session/core input scope", () => {
    const coreScopedTools = [
      "c2000_connectTarget",
      "c2000_disconnectTarget",
      "c2000_runCore",
      "c2000_continue",
      "c2000_haltCore",
      "c2000_pause",
      "c2000_reset",
      "c2000_getTargetState",
      "c2000_loadProgram",
      "c2000_evaluateMany",
      "c2000_assignExpression",
      "c2000_getLoadedProgramInfo",
      "c2000_resolvePc",
      "c2000_resolveAddress",
      "c2000_waitUntilExpression"
    ];

    for (const name of coreScopedTools) {
      const tool = c2000ToolDefinitions.find(candidate => candidate.name === name);
      expect(tool, name).toEqual(expect.objectContaining({ inputScope: "core" }));
      expect(Object.keys(tool?.schema.shape ?? {}), name).toEqual(expect.arrayContaining(["sessionId", "coreId"]));
    }
  });
});

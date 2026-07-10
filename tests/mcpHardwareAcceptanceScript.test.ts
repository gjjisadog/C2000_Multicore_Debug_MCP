import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("MCP hardware acceptance script contract", () => {
  test("provides a stdio MCP path for real CCS hardware acceptance", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };

    expect(packageJson.scripts["acceptance:ccs:mcp"]).toBe("npm run build --silent && tsx scripts/ccs-mcp-hardware-acceptance.ts");
  });

  test("uses MCP client tool calls rather than direct tool handlers", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain("StdioClientTransport");
    expect(source).toContain('name: "c2000_getToolContracts"');
    expect(source).toContain('name: "c2000_getDebugBoundary"');
    expect(source).toContain('name: "c2000_getAcceptanceEvidence"');
    expect(source).toContain('name: "c2000_getHardwarePreflight"');
    expect(source).toContain("discoverAcceptancePrograms");
    expect(source).toContain('name: "c2000_discoverAcceptancePrograms"');
    expect(source).not.toContain('from "../src/hardware/programDiscovery.js"');
    expect(source).toContain("programDiscovery");
    expect(source).toContain("C2000_PROGRAM_SEARCH_ROOTS");
    expect(source).toContain("workspace_ccstheia");
    expect(source).toContain("debugProcessDetails");
    expect(source).toContain("formatDebugProcessOwners");
    expect(source).toContain('name: "c2000_createDebugSession"');
    expect(source).toContain('name: "c2000_getSessionTopology"');
    expect(source).toContain('name: "c2000_connectCores"');
    expect(source).toContain('name: "c2000_loadPrograms"');
    expect(source).toContain('name: "c2000_getMulticoreSnapshot"');
    expect(source).toContain('name: "c2000_verifyRunPauseIsolation"');
    expect(source).toContain('name: "c2000_launchMulticoreDebug"');
    expect(source).toContain('name: "c2000_closeDebugSession"');
    expect(source).not.toContain("createToolHandlers");
    expect(source).not.toContain("new DebugSessionManager");
  });

  test("passes DSS timeout and optional log file into the stdio MCP server", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain('const dssTimeoutMs = process.env.C2000_MCP_DSS_TIMEOUT_MS ?? "300000"');
    expect(source).toContain('const mcpRequestTimeoutMs = Number.parseInt(process.env.C2000_MCP_REQUEST_TIMEOUT_MS ?? "600000", 10)');
    expect(source).toContain("C2000_MCP_DSS_TIMEOUT_MS: dssTimeoutMs");
    expect(source).toContain("...(process.env.C2000_MCP_LOG_FILE ? { C2000_MCP_LOG_FILE: process.env.C2000_MCP_LOG_FILE } : {})");
    expect(source).toContain("function callTool(params: Parameters<Client[\"callTool\"]>[0])");
    expect(source).toContain("return client.callTool(params, undefined, { timeout: mcpRequestTimeoutMs });");
    expect(source).toContain("structured(await callTool({");
  });

  test("checks tool contracts before touching the target", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain("assertToolContracts");
    expect(source).toContain('"c2000_getDebugBoundary", "host", "host-read", []');
    expect(source).toContain('"c2000_getAcceptanceEvidence", "host", "host-read", []');
    expect(source).toContain("assertDebugBoundary(debugBoundary)");
    expect(source).toContain("assertAcceptanceEvidence(acceptanceEvidence)");
    expect(source).toContain("buildUiIndependenceEvidence(debugBoundary)");
    expect(source).toContain("assertUiIndependenceEvidence(uiIndependenceEvidence)");
    expect(source).toContain("result.uiIndependenceEvidence = uiIndependenceEvidence");
    expect(source).toContain("result.toolContracts = contracts");
    expect(source).toContain("result.acceptanceEvidence = acceptanceEvidence");
    expect(source).toContain("c2000_multicore_acceptance_evidence_plan");
    expect(source).toContain("continue_cpu1_only");
    expect(source).toContain("continue_cpu2_only");
    expect(source).toContain("pause_cpu1_only");
    expect(source).toContain("pause_cpu2_only");
    expect(source).toContain("multicore_snapshot");
    expect(source).toContain("debug_tool_contracts");
    expect(source).toContain("multicore_tool_contracts");
    expect(source).toContain("core_read_tool_contracts");
    expect(source).toContain("advanced_automation_contracts");
    expect(source).toContain("no_ccs_ui_click");
    expect(source).toContain("no_ccs_ui_focus");
    expect(source).toContain("officialTiMcpDebugControlsUsed");
    expect(source).toContain("activeTargetAllowed");
    expect(source).toContain("perCoreDebugSessionMethods.c2000_continue");
    expect(source).toContain("realAdapter.defaultBridge");
    expect(source).toContain("PersistentDssBridge");
    expect(source).toContain("statelessDssCliBridgeUsedForDebugAutomation");
    expect(source).toContain("session.target.runAsynch()");
    expect(source).toContain("session.memory.loadProgram(programUri)");
    expect(source).toContain('"c2000_runCore", "core", "execution-control", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_continue", "core", "execution-control", ["sessionId", "coreId"]');
    expect(source).toContain('["coreId", "coreName"]');
    expect(source).toContain("responseCoreIdentityFields");
    expect(source).toContain('"c2000_haltCore", "core", "execution-control", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_pause", "core", "execution-control", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_connectTarget", "core", "connectivity-control", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_disconnectTarget", "core", "connectivity-control", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_reset", "core", "reset-control", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_getTargetState", "core", "target-read", ["sessionId", "coreId"]');
    expect(source).toContain('"c2000_loadProgram", "core", "program-load", ["sessionId", "coreId", "programUri"]');
    expect(source).toContain('"c2000_loadPrograms", "batch", "program-load", ["sessionId", "programs"]');
    expect(source).toContain('["results[].coreId", "results[].coreName"]');
    expect(source).toContain('"c2000_connectCores", "batch", "connectivity-control", ["sessionId", "coreIds"]');
    expect(source).toContain('"c2000_haltCores", "batch", "execution-control", ["sessionId", "coreIds"]');
    expect(source).toContain('"c2000_resetCores", "batch", "reset-control", ["sessionId", "coreIds"]');
    expect(source).toContain('"c2000_runCores", "batch", "execution-control", ["sessionId", "coreIds"]');
    expect(source).toContain('"c2000_evaluateMany", "core", "target-read", ["sessionId", "coreId", "expressions"], ["coreId", "coreName"]');
    expect(source).toContain('"c2000_getLoadedProgramInfo", "core", "target-read", ["sessionId", "coreId"], ["coreId", "coreName"]');
    expect(source).toContain('"c2000_resolvePc", "core", "target-read", ["sessionId", "coreId"], ["coreId", "coreName"]');
    expect(source).toContain('"c2000_resolveAddress", "core", "target-read", ["sessionId", "coreId", "address"], ["coreId", "coreName"]');
    expect(source).toContain('"c2000_waitUntilExpression", "core", "target-read", ["sessionId", "coreId", "expression", "expected", "timeoutMs"], ["coreId", "coreName"]');
    expect(source).toContain('"c2000_assignExpressions", "batch", "memory-write", ["sessionId", "assignments"], ["results[].coreId", "results[].coreName"]');
    expect(source).toContain('"c2000_injectFaults", "batch", "memory-write", ["sessionId", "faults"], ["results[].coreId", "results[].coreName"]');
    expect(source).toContain('"c2000_compareExpressions", "session", "target-read", ["sessionId", "comparisons"], ["comparisons[].left.coreId", "comparisons[].right.coreId"]');
    expect(source).toContain('"c2000_waitForExpressionSet", "session", "target-read", ["sessionId", "conditions", "timeoutMs"], ["conditions[].coreId"]');
    expect(source).toContain('"c2000_diagnoseCpu2Boot", "session", "target-read", ["sessionId", "cpu1CoreId", "cpu2CoreId"], ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]');
    expect(source).toContain('"c2000_getSessionTopology", "session", "session-read", ["sessionId"]');
    expect(source).toContain('"c2000_getMulticoreSnapshot", "session", "target-read", ["sessionId"]');
    expect(source).toContain('["cores[].coreId", "cores[].coreName"]');
    expect(source).toContain('"c2000_verifyRunPauseIsolation", "session", "execution-control", ["sessionId"]');
    expect(source).toContain('["acceptanceSummary.steps[].commandCoreId", "acceptanceSummary.steps[].commandCoreName"]');
    expect(source).toContain('"c2000_launchMulticoreDebug", "launch", "launch-workflow", ["cores"], ["snapshot.cores[].coreId", "postLaunchActions.assignExpressions.results[].coreId", "postLaunchActions.injectFaults.results[].coreId"');
    expect(source).toContain('"c2000_closeDebugSession", "session", "session-lifecycle", ["sessionId"]');
    expect(source).toContain('assertCoreIdentityFields(contracts, "c2000_assignExpressions", ["assignments[].coreId"])');
    expect(source).toContain('assertCoreIdentityFields(contracts, "c2000_injectFaults", ["faults[].coreId"])');
    expect(source).toContain('assertCoreIdentityFields(contracts, "c2000_compareExpressions", ["comparisons[].left.coreId", "comparisons[].right.coreId"])');
    expect(source).toContain('assertCoreIdentityFields(contracts, "c2000_waitForExpressionSet", ["conditions[].coreId"])');
    expect(source).toContain('assertCoreIdentityFields(contracts, "c2000_diagnoseCpu2Boot", ["cpu1CoreId", "cpu2CoreId"])');
    expect(source).toContain('assertCoreIdentityFields(contracts, "c2000_launchMulticoreDebug", [');
  });

  test("can optionally run launchMulticoreDebug hardware acceptance through MCP stdio", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain('const runLaunch = process.env.C2000_RUN_LAUNCH === "1"');
    expect(source).toContain('mode: modeName(runIsolation, runLaunch)');
    expect(source).toContain('name: "c2000_launchMulticoreDebug"');
    expect(source).toContain('sessionName: "f28p65x-mcp-hardware-launch-acceptance"');
    expect(source).toContain("programDiscovery: {");
    expect(source).toContain("enabled: true");
    expect(source).toContain("assert.equal(launch.programDiscovery.cpu1.selected, cpu1Program)");
    expect(source).toContain("assert.equal(launch.programDiscovery.cpu2.selected, cpu2Program)");
    expect(source).not.toContain('programUri: cpu1Program, connect: true, load: true');
    expect(source).not.toContain('programUri: cpu2Program, connect: true, load: true');
    expect(source).toContain("postLaunchChecks: runIsolation ? { verifyRunPauseIsolation: {} } : undefined");
    expect(source).toContain("assertSnapshotCoreState(launch.snapshot, [0, 2])");
    expect(source).toContain("assertSnapshotLoadedPrograms(launch.snapshot, cpu1Program, cpu2Program)");
    expect(source).toContain("assertAcceptanceSummaryWithEvidence(launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary, result)");
    expect(source).toContain("result.launch = launch");
    expect(source).toContain("result.programDiscovery = programDiscovery");
    expect(source).toContain("let launchSessionId: string | undefined");
    expect(source).toContain('await callTool({ name: "c2000_closeDebugSession", arguments: { sessionId: launchSessionId } })');
  });

  test("prints a machine-readable isolation acceptance summary", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");
    const helperSource = await readFile("src/debug/runPauseAcceptance.ts", "utf8");

    expect(source).toContain("assertAcceptanceSummaryWithEvidence(isolation.acceptanceSummary, result)");
    expect(source).toContain('assertRunPauseAcceptanceSummary as assertAcceptanceSummary');
    expect(source).not.toContain("function assertAcceptanceSummary(summary");
    expect(source).toContain("assertAcceptanceSummary");
    expect(source).toContain("result.acceptanceSummary");
    expect(source).toContain("result.acceptanceSummary = isolation.acceptanceSummary");
    expect(source.indexOf("result.isolation = isolation")).toBeLessThan(source.indexOf("assertAcceptanceSummaryWithEvidence(isolation.acceptanceSummary, result)"));
    expect(source).toContain("assertAcceptanceSummaryWithEvidence(isolation.acceptanceSummary, result)");
    expect(source).toContain("printFailureEvidence(evidence, error)");
    expect(source).not.toContain("?? buildAcceptanceSummary");
    expect(helperSource).toContain("acceptanceSummary.success");
    expect(helperSource).toContain('assert.equal(acceptanceSummary.evidence, RUN_PAUSE_ACCEPTANCE_EVIDENCE)');
    expect(helperSource).toContain("assert.deepEqual(acceptanceSummary.requiredLabels");
    expect(helperSource).toContain('"c2000_continue(cpu1)"');
    expect(helperSource).toContain('"c2000_pause(cpu1)"');
    expect(helperSource).toContain('"c2000_continue(cpu2)"');
    expect(helperSource).toContain('"c2000_pause(cpu2)"');
    expect(helperSource).toContain('{ label: "c2000_continue(cpu1)", targetCoreId: 0, targetCoreName: "C28xx_CPU1", expectedTargetState: "Running", peerCoreIds: [2] }');
    expect(helperSource).toContain('{ label: "c2000_pause(cpu1)", targetCoreId: 0, targetCoreName: "C28xx_CPU1", expectedTargetState: "Halted", peerCoreIds: [2] }');
    expect(helperSource).toContain('{ label: "c2000_continue(cpu2)", targetCoreId: 2, targetCoreName: "C28xx_CPU2", expectedTargetState: "Running", peerCoreIds: [0] }');
    expect(helperSource).toContain('{ label: "c2000_pause(cpu2)", targetCoreId: 2, targetCoreName: "C28xx_CPU2", expectedTargetState: "Halted", peerCoreIds: [0] }');
    expect(helperSource).toContain("step.targetCoreId");
    expect(helperSource).toContain("step.commandCoreId");
    expect(helperSource).toContain("step.commandCoreName");
    expect(helperSource).toContain("step.expectedTargetState");
    expect(helperSource).toContain("step.peerCoreIds");
    expect(helperSource).toContain("step.failures");
    expect(helperSource).toContain("commandCoreId mismatch");
    expect(helperSource).toContain("commandCoreName mismatch");
    expect(helperSource).toContain("targetCoreName");
    expect(helperSource).toContain("assert.deepEqual(step.peerCoreIds");
    expect(helperSource).toContain("assert.equal(step.failures.length, 0");
  });

  test("prints launch isolation evidence before failing acceptance assertions", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source.indexOf("result.launch = launch")).toBeLessThan(source.indexOf("assertAcceptanceSummaryWithEvidence(launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary, result)"));
    expect(source.indexOf("result.launchAcceptanceSummary = launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary")).toBeLessThan(source.indexOf("assertAcceptanceSummaryWithEvidence(launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary, result)"));
  });

  test("prints machine-readable evidence when isolation or launch tool calls fail", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain("function assertSuccessWithEvidence");
    expect(source).toContain("printFailureEvidence({ ...evidence, failedToolResult: result }, error)");
    expect(source.indexOf("result.isolation = isolation")).toBeLessThan(source.indexOf('assertSuccessWithEvidence("c2000_verifyRunPauseIsolation", isolation, result, { initialSnapshot })'));
    expect(source.indexOf("result.launch = launch")).toBeLessThan(source.indexOf('assertSuccessWithEvidence("c2000_launchMulticoreDebug", launch, result, { preflight })'));
  });

  test("verifies loaded program metadata in the initial multicore snapshot", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain("assertSnapshotLoadedPrograms(initialSnapshot, cpu1Program, cpu2Program)");
    expect(source).toContain("assertCoreLoadedProgram(snapshot, 0, cpu1Program)");
    expect(source).toContain("assertCoreLoadedProgram(snapshot, 2, cpu2Program)");
    expect(source).toContain("core.loadedProgramInfo?.programUri");
    expect(source).toContain("core.loadedProgramInfo?.coreId");
    expect(source).toContain("core.loadedProgramInfo?.sha256");
    expect(source).toContain("core.loadedProgramInfo?.symbolsLoaded");
  });

  test("captures and verifies logical topology before target control", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain('name: "c2000_getSessionTopology"');
    expect(source).toContain("assertSessionTopology(topology)");
    expect(source).toContain("result.topology = topology");
    expect(source).toContain("topology.adapterSessionId");
    expect(source).toContain("topology.debugSessionRoute");
    expect(source).toContain("core0.debugSessionKey");
    expect(source).toContain("core2.debugSessionKey");
    expect(source.indexOf('name: "c2000_getSessionTopology"')).toBeLessThan(source.indexOf('name: "c2000_connectCores"'));
    expect(source).toContain('assert.equal(core0.targetSelector, "C28xx_CPU1", "core 0 targetSelector")');
    expect(source).toContain('assert.equal(core2.targetSelector, "C28xx_CPU2", "core 2 targetSelector")');
  });

  test("verifies connection state, run state, and PC fields in the initial multicore snapshot", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain("assertSnapshotCoreState(initialSnapshot, [0, 2])");
    expect(source).toContain("function assertSnapshotCoreState");
    expect(source).toContain("assertSnapshotCoreIdentity(snapshot, coreId)");
    expect(source).toContain("function assertSnapshotCoreIdentity");
    expect(source).toContain("assert.equal(core.coreName, expectedCoreName(coreId)");
    expect(source).toContain("function expectedCoreName");
    expect(source).toContain('assert.equal(core.connected, true, `core ${coreId} connected`)');
    expect(source).toContain('assert.equal(core.state, "Halted", `core ${coreId} state`)');
    expect(source).toContain('assert.equal(typeof core.pc, "string", `core ${coreId} pc`)');
  });

  test("checks per-core batch results for connect and load before continuing", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain('assertBatchCoreResults("c2000_connectCores", connect, [0, 2])');
    expect(source).toContain('assertBatchCoreResults("c2000_loadPrograms", load, [0, 2])');
    expect(source).toContain("function assertBatchCoreResults");
  });

  test("does not let cleanup failures hide the primary MCP hardware acceptance failure", async () => {
    const source = await readFile("scripts/ccs-mcp-hardware-acceptance.ts", "utf8");

    expect(source).toContain("let primaryError: unknown");
    expect(source).toContain("primaryError = error");
    expect(source).toContain('await callTool({ name: "c2000_closeDebugSession", arguments: { sessionId } })');
    expect(source).toContain("if (primaryError)");
    expect(source).toContain("c2000_closeDebugSession cleanup failed after primary failure");
    expect(source).toContain("throw cleanupError");
  });
});

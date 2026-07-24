import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertAcceptanceEvidence, assertUiIndependenceEvidence, buildUiIndependenceEvidence } from "../src/debug/boundary.js";
import { assertRunPauseAcceptanceSummary as assertAcceptanceSummary } from "../src/debug/runPauseAcceptance.js";
import { resolveCcxmlPath, resolveCcsInstallPath } from "../src/ccs/paths.js";
import { formatDebugProcessOwners } from "../src/hardware/preflight.js";
import { resolveTiEnvironment } from "../src/config/tiPaths.js";

const environment = await resolveTiEnvironment({
  ccsInstallPath: process.env.C2000_MCP_CCS_INSTALL_PATH,
  c2000WarePath: process.env.C2000_MCP_C2000WARE_PATH,
  ccxmlPath: process.env.C2000_MCP_CCXML_PATH
});
const ccsInstallPath = environment.ccs.path ?? "";
const ccxmlPath = environment.ccxml.path ?? "";
const runIsolation = process.env.C2000_RUN_ISOLATION === "1";
const runLaunch = process.env.C2000_RUN_LAUNCH === "1";
const allowExistingDebugProcesses = process.env.C2000_ALLOW_EXISTING_DEBUG_PROCESSES === "1";
const dssTimeoutMs = process.env.C2000_MCP_DSS_TIMEOUT_MS ?? "300000";
const mcpRequestTimeoutMs = Number.parseInt(process.env.C2000_MCP_REQUEST_TIMEOUT_MS ?? "600000", 10);
let programDiscovery: Record<string, any> = {};
let cpu1Program = "";
let cpu2Program = "";

await assertFile(ccxmlPath);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    C2000_MCP_ADAPTER: "ccs",
    C2000_MCP_CCS_INSTALL_PATH: ccsInstallPath,
    C2000_MCP_C2000WARE_PATH: environment.c2000Ware.path ?? "",
    C2000_MCP_CCXML_PATH: ccxmlPath,
    C2000_MCP_DSS_TIMEOUT_MS: dssTimeoutMs,
    C2000_MCP_LOG_LEVEL: process.env.C2000_MCP_LOG_LEVEL ?? "error",
    ...(process.env.C2000_MCP_LOG_FILE ? { C2000_MCP_LOG_FILE: process.env.C2000_MCP_LOG_FILE } : {})
  }
});
const stderrChunks: Buffer[] = [];
transport.stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

const client = new Client({ name: "c2000-mcp-hardware-acceptance", version: "0.1.0" });
let sessionId: string | undefined;
let launchSessionId: string | undefined;
let primaryError: unknown;

try {
  await client.connect(transport);

  const contracts = structured(await callTool({
    name: "c2000_getToolContracts",
    arguments: {}
  }));
  assertSuccess("c2000_getToolContracts", contracts);
  assertToolContracts(contracts);

  programDiscovery = structured(await callTool({
    name: "c2000_discoverAcceptancePrograms",
    arguments: {
      cpu1Program: process.env.C2000_CPU1_OUT,
      cpu2Program: process.env.C2000_CPU2_OUT,
      searchRoots: programSearchRoots()
    }
  }));
  assertSuccess("c2000_discoverAcceptancePrograms", programDiscovery);
  cpu1Program = requiredProgram("C2000_CPU1_OUT", programDiscovery.cpu1);
  cpu2Program = requiredProgram("C2000_CPU2_OUT", programDiscovery.cpu2);
  await assertFile(cpu1Program);
  await assertFile(cpu2Program);

  const debugBoundary = structured(await callTool({
    name: "c2000_getDebugBoundary",
    arguments: {}
  }));
  assertSuccess("c2000_getDebugBoundary", debugBoundary);
  assertDebugBoundary(debugBoundary);
  const uiIndependenceEvidence = buildUiIndependenceEvidence(debugBoundary);
  assertUiIndependenceEvidence(uiIndependenceEvidence);
  const acceptanceEvidence = structured(await callTool({
    name: "c2000_getAcceptanceEvidence",
    arguments: {}
  }));
  assertSuccess("c2000_getAcceptanceEvidence", acceptanceEvidence);
  assertAcceptanceEvidence(acceptanceEvidence);
  assertExplicitAcceptanceEvidenceIds(acceptanceEvidence);

  const preflight = structured(await callTool({
    name: "c2000_getHardwarePreflight",
    arguments: { ccsInstallPath }
  }));
  assertSuccess("c2000_getHardwarePreflight", preflight);
  const debugProcesses = Array.isArray(preflight.debugProcesses) ? preflight.debugProcesses : [];
  const debugProcessDetails = Array.isArray(preflight.debugProcessDetails) ? preflight.debugProcessDetails : [];
  if (!allowExistingDebugProcesses && debugProcesses.length > 0) {
    throw new Error(`Existing debug-related process(es) may own the XDS probe: ${formatDebugProcessOwners({ debugProcesses, debugProcessDetails } as any)}. Close CCS debug sessions or set C2000_ALLOW_EXISTING_DEBUG_PROCESSES=1 to override: ${JSON.stringify(preflight, null, 2)}`);
  }

  const created = structured(await callTool({
    name: "c2000_createDebugSession",
    arguments: {
      sessionName: "f28p65x-mcp-hardware-acceptance",
      ccxmlPath,
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
      ]
    }
  }));
  assertSuccess("c2000_createDebugSession", created, { preflight });
  assert.equal(typeof created.sessionId, "string");
  sessionId = created.sessionId as string;

  const topology = structured(await callTool({
    name: "c2000_getSessionTopology",
    arguments: { sessionId }
  }));
  assertSuccess("c2000_getSessionTopology", topology, { preflight });
  assertSessionTopology(topology);

  const connect = structured(await callTool({
    name: "c2000_connectCores",
    arguments: { sessionId, coreIds: [0, 2] }
  }));
  assertSuccess("c2000_connectCores", connect, { preflight });
  assertBatchCoreResults("c2000_connectCores", connect, [0, 2]);

  const load = structured(await callTool({
    name: "c2000_loadPrograms",
    arguments: {
      sessionId,
      programs: [
        { coreId: 0, programUri: cpu1Program },
        { coreId: 2, programUri: cpu2Program }
      ]
    }
  }));
  assertSuccess("c2000_loadPrograms", load, { preflight });
  assertBatchCoreResults("c2000_loadPrograms", load, [0, 2]);

  const initialSnapshot = structured(await callTool({
    name: "c2000_getMulticoreSnapshot",
    arguments: { sessionId }
  }));
  assertSuccess("c2000_getMulticoreSnapshot(initial)", initialSnapshot, { preflight });
  assertSnapshotCoreState(initialSnapshot, [0, 2]);
  assertSnapshotLoadedPrograms(initialSnapshot, cpu1Program, cpu2Program);

  const result: Record<string, unknown> = {
    transport: "mcp-stdio",
    mode: modeName(runIsolation, runLaunch),
    sessionId,
    debugBoundary,
    preflight,
    initialSnapshot
  };
  result.toolContracts = contracts;
  result.uiIndependenceEvidence = uiIndependenceEvidence;
  result.acceptanceEvidence = acceptanceEvidence;
  result.programDiscovery = programDiscovery;
  result.topology = topology;

  if (runIsolation) {
    const isolation = structured(await callTool({
      name: "c2000_verifyRunPauseIsolation",
      arguments: { sessionId }
    }));
    result.isolation = isolation;
    result.finalSnapshot = isolation.finalSnapshot;
    result.acceptanceSummary = isolation.acceptanceSummary;
    assertSuccessWithEvidence("c2000_verifyRunPauseIsolation", isolation, result, { initialSnapshot });
    assertAcceptanceSummaryWithEvidence(isolation.acceptanceSummary, result);
  }

  if (runLaunch) {
    const closeMain = structured(await callTool({
      name: "c2000_closeDebugSession",
      arguments: { sessionId }
    }));
    assertSuccess("c2000_closeDebugSession(main-before-launch)", closeMain, { preflight });
    sessionId = undefined;

    const launch = structured(await callTool({
      name: "c2000_launchMulticoreDebug",
      arguments: {
        sessionName: "f28p65x-mcp-hardware-launch-acceptance",
        ccxmlPath,
        programDiscovery: {
          enabled: true,
          cpu1Program,
          cpu2Program,
          searchRoots: programSearchRoots()
        },
        cores: [
          { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", connect: true, load: true, haltAtEntry: true },
          { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", connect: true, load: true, haltAtEntry: true }
        ],
        postLaunchChecks: runIsolation ? { verifyRunPauseIsolation: {} } : undefined
      }
    }));
    result.launch = launch;
    assertSuccessWithEvidence("c2000_launchMulticoreDebug", launch, result, { preflight });
    assert.equal(typeof launch.sessionId, "string");
    launchSessionId = launch.sessionId as string;
    assert.equal(launch.programDiscovery.cpu1.selected, cpu1Program);
    assert.equal(launch.programDiscovery.cpu2.selected, cpu2Program);
    assertSnapshotCoreState(launch.snapshot, [0, 2]);
    assertSnapshotLoadedPrograms(launch.snapshot, cpu1Program, cpu2Program);
    if (runIsolation) {
      result.launchAcceptanceSummary = launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary;
      assertAcceptanceSummaryWithEvidence(launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary, result);
    }
  }

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (sessionId) {
    try {
      await callTool({ name: "c2000_closeDebugSession", arguments: { sessionId } });
    } catch (cleanupError) {
      if (primaryError) {
        process.stderr.write(`c2000_closeDebugSession cleanup failed after primary failure: ${formatCleanupError(cleanupError)}\n`);
      } else {
        throw cleanupError;
      }
    }
  }
  if (launchSessionId) {
    try {
      await callTool({ name: "c2000_closeDebugSession", arguments: { sessionId: launchSessionId } });
    } catch (cleanupError) {
      if (primaryError) {
        process.stderr.write(`c2000_closeDebugSession launch cleanup failed after primary failure: ${formatCleanupError(cleanupError)}\n`);
      } else {
        throw cleanupError;
      }
    }
  }
  await client.close();
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (stderr) {
    process.stderr.write(`${stderr}\n`);
  }
}

function requiredProgram(envName: string, entry: { selected?: string; candidates: string[] }): string {
  if (!entry.selected) {
    throw new Error(`${envName} is required or discoverable. Searched candidates: ${JSON.stringify(entry.candidates)}`);
  }
  return entry.selected;
}

function programSearchRoots(): string[] {
  const configured = process.env.C2000_PROGRAM_SEARCH_ROOTS;
  if (configured) {
    return configured.split(path.delimiter).filter(Boolean);
  }
  return [path.join(os.homedir(), "workspace_ccstheia")];
}

async function assertFile(filePath: string) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  assert(result.structuredContent && typeof result.structuredContent === "object", "tool result must include structuredContent");
  return result.structuredContent as Record<string, any>;
}

function callTool(params: Parameters<Client["callTool"]>[0]) {
  return client.callTool(params, undefined, { timeout: mcpRequestTimeoutMs });
}

function assertSuccess(label: string, result: Record<string, any>, context: Record<string, unknown> = {}) {
  if (!result.success) {
    throw new Error(`${label} failed: ${JSON.stringify({ result, ...context }, null, 2)}`);
  }
}

function assertSuccessWithEvidence(
  label: string,
  result: Record<string, any>,
  evidence: Record<string, unknown>,
  context: Record<string, unknown> = {}
) {
  try {
    assertSuccess(label, result, context);
  } catch (error) {
    printFailureEvidence({ ...evidence, failedToolResult: result }, error);
    throw error;
  }
}

function assertAcceptanceSummaryWithEvidence(summary: unknown, evidence: Record<string, unknown>) {
  try {
    assertAcceptanceSummary(summary);
  } catch (error) {
    printFailureEvidence(evidence, error);
    throw error;
  }
}

function printFailureEvidence(evidence: Record<string, unknown>, error: unknown) {
  process.stdout.write(`${JSON.stringify({
    success: false,
    error: formatCleanupError(error),
    evidence
  }, null, 2)}\n`);
}

function assertBatchCoreResults(label: string, result: Record<string, any>, expectedCoreIds: number[]) {
  const items = Array.isArray(result.results) ? result.results as Array<Record<string, any>> : [];
  for (const coreId of expectedCoreIds) {
    const item = items.find(candidate => candidate.coreId === coreId);
    if (!item || item.success !== true) {
      throw new Error(`${label} did not succeed for core ${coreId}: ${JSON.stringify(result, null, 2)}`);
    }
  }
}

function assertSnapshotLoadedPrograms(snapshot: Record<string, any>, cpu1Program: string, cpu2Program: string) {
  assertCoreLoadedProgram(snapshot, 0, cpu1Program);
  assertCoreLoadedProgram(snapshot, 2, cpu2Program);
}

function assertSnapshotCoreState(snapshot: Record<string, any>, coreIds: number[]) {
  for (const coreId of coreIds) {
    const core = findSnapshotCore(snapshot, coreId);
    assertSnapshotCoreIdentity(snapshot, coreId);
    assert.equal(core.connected, true, `core ${coreId} connected`);
    assert.equal(core.state, "Halted", `core ${coreId} state`);
    assert.equal(typeof core.pc, "string", `core ${coreId} pc`);
    assert.notEqual(core.pc.length, 0, `core ${coreId} pc`);
  }
}

function assertCoreLoadedProgram(snapshot: Record<string, any>, coreId: number, programUri: string) {
  const core = findSnapshotCore(snapshot, coreId);
  assertSnapshotCoreIdentity(snapshot, coreId);
  assert.equal(core.loadedProgram, programUri, `core ${coreId} loadedProgram`);
  assert.equal(core.loadedProgramInfo?.programUri, programUri, `core ${coreId} loadedProgramInfo.programUri`);
  assert.equal(core.loadedProgramInfo?.coreId, coreId, `core ${coreId} loadedProgramInfo.coreId`);
  assert.equal(typeof core.loadedProgramInfo?.sha256, "string", `core ${coreId} loadedProgramInfo.sha256`);
  assert.equal(core.loadedProgramInfo.sha256.length, 64, `core ${coreId} loadedProgramInfo.sha256 length`);
  assert.equal(core.loadedProgramInfo?.symbolsLoaded, true, `core ${coreId} loadedProgramInfo.symbolsLoaded`);
}

function findSnapshotCore(snapshot: Record<string, any>, coreId: number) {
  const cores = Array.isArray(snapshot.cores) ? snapshot.cores as Array<Record<string, any>> : [];
  const core = cores.find(candidate => candidate.coreId === coreId);
  if (!core) {
    throw new Error(`Snapshot is missing core ${coreId}`);
  }
  return core;
}

function assertSnapshotCoreIdentity(snapshot: Record<string, any>, coreId: number) {
  const core = findSnapshotCore(snapshot, coreId);
  assert.equal(core.coreName, expectedCoreName(coreId), `core ${coreId} coreName`);
}

function expectedCoreName(coreId: number): string {
  if (coreId === 0) {
    return "C28xx_CPU1";
  }
  if (coreId === 2) {
    return "C28xx_CPU2";
  }
  throw new Error(`Unexpected F28P65x coreId ${coreId}`);
}

function assertSessionTopology(topology: Record<string, any>) {
  assert.equal(typeof topology.adapterSessionId, "string", "topology adapterSessionId");
  assert.equal(topology.adapterName, "ccs-scripting", "topology adapterName");
  assert.equal(topology.debugSessionRoute, "sessionId -> adapterSessionId -> coreId -> DebugSession", "topology debugSessionRoute");
  const cores = Array.isArray(topology.cores) ? topology.cores as Array<Record<string, any>> : [];
  const core0 = cores.find(core => core.coreId === 0);
  const core2 = cores.find(core => core.coreId === 2);
  assert(core0, "topology is missing core 0");
  assert(core2, "topology is missing core 2");
  assert.equal(core0.coreName, "C28xx_CPU1", "core 0 coreName");
  assert.equal(core0.corePattern, "C28xx_CPU1", "core 0 corePattern");
  assert.equal(core0.targetSelector, "C28xx_CPU1", "core 0 targetSelector");
  assert.equal(core0.debugSessionKey, `${topology.adapterSessionId}:0`, "core 0 debugSessionKey");
  assert.equal(core2.coreName, "C28xx_CPU2", "core 2 coreName");
  assert.equal(core2.corePattern, "C28xx_CPU2", "core 2 corePattern");
  assert.equal(core2.targetSelector, "C28xx_CPU2", "core 2 targetSelector");
  assert.equal(core2.debugSessionKey, `${topology.adapterSessionId}:2`, "core 2 debugSessionKey");
}

function assertToolContracts(contracts: Record<string, any>) {
  assertToolContract(contracts, "c2000_getDebugBoundary", "host", "host-read", []);
  assertToolContract(contracts, "c2000_getAcceptanceEvidence", "host", "host-read", []);
  assertToolContract(contracts, "c2000_discoverAcceptancePrograms", "host", "host-read", []);
  assertToolContract(contracts, "c2000_connectTarget", "core", "connectivity-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_disconnectTarget", "core", "connectivity-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_runCore", "core", "execution-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_continue", "core", "execution-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_haltCore", "core", "execution-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_pause", "core", "execution-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_reset", "core", "reset-control", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_getTargetState", "core", "target-read", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_loadProgram", "core", "program-load", ["sessionId", "coreId", "programUri"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_loadPrograms", "batch", "program-load", ["sessionId", "programs"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_connectCores", "batch", "connectivity-control", ["sessionId", "coreIds"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_haltCores", "batch", "execution-control", ["sessionId", "coreIds"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_resetCores", "batch", "reset-control", ["sessionId", "coreIds"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_runCores", "batch", "execution-control", ["sessionId", "coreIds"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_evaluateMany", "core", "target-read", ["sessionId", "coreId", "expressions"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_getLoadedProgramInfo", "core", "target-read", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_resolvePc", "core", "target-read", ["sessionId", "coreId"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_resolveAddress", "core", "target-read", ["sessionId", "coreId", "address"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_waitUntilExpression", "core", "target-read", ["sessionId", "coreId", "expression", "expected", "timeoutMs"], ["coreId", "coreName"]);
  assertToolContract(contracts, "c2000_assignExpressions", "batch", "memory-write", ["sessionId", "assignments"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_injectFaults", "batch", "memory-write", ["sessionId", "faults"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_compareExpressions", "session", "target-read", ["sessionId", "comparisons"], ["comparisons[].left.coreId", "comparisons[].right.coreId"]);
  assertToolContract(contracts, "c2000_waitForExpressionSet", "session", "target-read", ["sessionId", "conditions", "timeoutMs"], ["conditions[].coreId"]);
  assertToolContract(contracts, "c2000_diagnoseCpu2Boot", "session", "target-read", ["sessionId", "cpu1CoreId", "cpu2CoreId"], ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]);
  assertToolContract(contracts, "c2000_getSessionTopology", "session", "session-read", ["sessionId"]);
  assertToolContract(contracts, "c2000_getMulticoreSnapshot", "session", "target-read", ["sessionId"], ["cores[].coreId", "cores[].coreName"]);
  assertToolContract(contracts, "c2000_verifyRunPauseIsolation", "session", "execution-control", ["sessionId"], ["acceptanceSummary.steps[].commandCoreId", "acceptanceSummary.steps[].commandCoreName"]);
  assertToolContract(contracts, "c2000_launchMulticoreDebug", "launch", "launch-workflow", ["cores"], ["snapshot.cores[].coreId", "postLaunchActions.assignExpressions.results[].coreId", "postLaunchActions.injectFaults.results[].coreId", "postLaunchChecks.waitForExpressionSet.conditions[].coreId", "postLaunchChecks.compareExpressions.comparisons[].left.coreId", "postLaunchChecks.compareExpressions.comparisons[].right.coreId", "postLaunchChecks.diagnoseCpu2Boot.cpu1.coreId", "postLaunchChecks.diagnoseCpu2Boot.cpu2.coreId", "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreId", "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreName"]);
  assertToolContract(contracts, "c2000_closeDebugSession", "session", "session-lifecycle", ["sessionId"]);
  assertCoreIdentityFields(contracts, "c2000_assignExpressions", ["assignments[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_evaluateMany", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_getLoadedProgramInfo", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_resolvePc", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_resolveAddress", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_waitUntilExpression", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_injectFaults", ["faults[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_compareExpressions", ["comparisons[].left.coreId", "comparisons[].right.coreId"]);
  assertCoreIdentityFields(contracts, "c2000_waitForExpressionSet", ["conditions[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_diagnoseCpu2Boot", ["cpu1CoreId", "cpu2CoreId"]);
  assertCoreIdentityFields(contracts, "c2000_launchMulticoreDebug", [
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
  ]);
}

function assertDebugBoundary(debugBoundary: Record<string, any>) {
  assert.equal(debugBoundary.officialTiMcpDebugControlsUsed, false);
  assert.equal(debugBoundary.activeTargetAllowed, false);
  assert.equal(debugBoundary.uiFocusRequired, false);
  assert.equal(debugBoundary.continueSemantics, "non-blocking");
  assert.deepEqual(debugBoundary.requiredPerCoreInputs, ["sessionId", "coreId"]);
  assert.deepEqual(debugBoundary.coreIdConvention, { "0": "C28xx_CPU1", "2": "C28xx_CPU2" });
  assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_connectTarget, "session.target.connect()");
  assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_disconnectTarget, "session.target.disconnect()");
  assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_continue, "session.target.runAsynch()");
  assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_pause, "session.target.halt()");
  assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_reset, "session.target.reset()");
  assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_loadProgram, "session.memory.loadProgram(programUri)");
  assert.equal(debugBoundary.realAdapter.name, "CcsScriptingAdapter");
  assert.equal(debugBoundary.realAdapter.defaultBridge, "PersistentDssBridge");
  assert.equal(debugBoundary.realAdapter.maintainsPersistentDebugSessions, true);
  assert.equal(debugBoundary.realAdapter.statelessDssCliBridgeUsedForDebugAutomation, false);
  assert(Array.isArray(debugBoundary.forbiddenOfficialDebugTools));
  assert(debugBoundary.forbiddenOfficialDebugTools.includes("continue"));
  assert(Array.isArray(debugBoundary.c2000DebugTools));
  assert(debugBoundary.c2000DebugTools.includes("c2000_continue"));
}

function assertToolContract(
  contracts: Record<string, any>,
  name: string,
  inputScope: string,
  targetEffect: string,
  requiredInputFields: string[],
  responseCoreIdentityFields: string[] = []
) {
  const tools = Array.isArray(contracts.tools) ? contracts.tools as Array<Record<string, any>> : [];
  const contract = tools.find(tool => tool.name === name);
  if (!contract) {
    throw new Error(`Missing required MCP tool contract: ${name}`);
  }
  assert.equal(contract.inputScope, inputScope, `${name} inputScope`);
  assert.equal(contract.targetEffect, targetEffect, `${name} targetEffect`);
  const actualRequired = Array.isArray(contract.requiredInputFields) ? contract.requiredInputFields : [];
  for (const field of requiredInputFields) {
    assert(actualRequired.includes(field), `${name} must require ${field}`);
  }
  if (responseCoreIdentityFields.length > 0) {
    assert.deepEqual(contract.responseCoreIdentityFields, responseCoreIdentityFields, `${name} responseCoreIdentityFields`);
  }
}

function assertCoreIdentityFields(contracts: Record<string, any>, name: string, expectedCoreIdentityFields: string[]) {
  const tools = Array.isArray(contracts.tools) ? contracts.tools as Array<Record<string, any>> : [];
  const contract = tools.find(tool => tool.name === name);
  if (!contract) {
    throw new Error(`Missing required MCP tool contract: ${name}`);
  }
  assert.deepEqual(contract.coreIdentityFields, expectedCoreIdentityFields, `${name} coreIdentityFields`);
}

function assertExplicitAcceptanceEvidenceIds(acceptanceEvidence: Record<string, any>) {
  assert.equal(acceptanceEvidence.evidence, "c2000_multicore_acceptance_evidence_plan");
  const requirements = Array.isArray(acceptanceEvidence.requirements)
    ? acceptanceEvidence.requirements as Array<Record<string, any>>
    : [];
  for (const id of [
    "continue_cpu1_only",
    "continue_cpu2_only",
    "pause_cpu1_only",
    "pause_cpu2_only",
    "multicore_snapshot",
    "debug_tool_contracts",
    "multicore_tool_contracts",
    "core_read_tool_contracts",
    "advanced_automation_contracts",
    "no_ccs_ui_click",
    "no_ccs_ui_focus"
  ]) {
    assert(requirements.some(requirement => requirement.id === id), `acceptanceEvidence is missing ${id}`);
  }
}

function formatCleanupError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return JSON.stringify(error);
}

function modeName(runIsolation: boolean, runLaunch: boolean): string {
  if (runIsolation && runLaunch) {
    return "connect-load-state-run-pause-launch-run-pause";
  }
  if (runLaunch) {
    return "connect-load-state-launch";
  }
  return runIsolation ? "connect-load-state-run-pause" : "connect-load-state";
}

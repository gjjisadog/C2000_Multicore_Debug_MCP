import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertRunPauseAcceptanceSummary as assertAcceptanceSummary } from "../src/debug/runPauseAcceptance.js";

const requiredTools = [
  "c2000_getToolContracts",
  "c2000_getDebugBoundary",
  "c2000_getAcceptanceEvidence",
  "c2000_getHardwarePreflight",
  "c2000_discoverAcceptancePrograms",
  "c2000_getAcceptanceReadiness",
  "c2000_analyzeRamOwnership",
  "c2000_createDebugSession",
  "c2000_getSessionTopology",
  "c2000_connectCores",
  "c2000_loadProgram",
  "c2000_loadPrograms",
  "c2000_runCore",
  "c2000_continue",
  "c2000_haltCore",
  "c2000_pause",
  "c2000_reset",
  "c2000_getTargetState",
  "c2000_disconnectTarget",
  "c2000_evaluateMany",
  "c2000_getLoadedProgramInfo",
  "c2000_resolvePc",
  "c2000_resolveAddress",
  "c2000_waitUntilExpression",
  "c2000_assignExpressions",
  "c2000_injectFaults",
  "c2000_diagnoseBootHandoff",
  "c2000_waitForIpcReady",
  "c2000_verifyRunPauseIsolation",
  "c2000_reloadResetRunToMain",
  "c2000_launchAndRunIpcAcceptance",
  "c2000_runIpcAcceptance",
  "c2000_runBootHandoffDiagnosis",
  "c2000_runReloadAndDiagnose",
  "c2000_runFullDebugBundle",
  "c2000_getMulticoreSnapshot",
  "c2000_launchMulticoreDebug",
  "c2000_closeDebugSession"
];

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/index.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      C2000_MCP_ADAPTER: "mock",
      C2000_MCP_LOG_LEVEL: "error",
      C2000_MCP_TOOL_PROFILE: "full",
      C2000_MCP_ALLOWED_READ_ROOTS: tmpdir(),
      C2000_MCP_ALLOWED_WRITE_ROOTS: tmpdir()
    }
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

  const client = new Client({ name: "c2000-mcp-stdio-smoke", version: "0.1.0" });
  const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-stdio-smoke-"));
  const ccxmlPath = path.join(tempDir, "target.ccxml");
  const cpu1Out = path.join(tempDir, "cpu1.out");
  const cpu1ReloadOut = path.join(tempDir, "cpu1-reload.out");
  const cpu2Out = path.join(tempDir, "cpu2.out");
  const launchCpu1Out = path.join(tempDir, "launch-cpu1.out");
  const launchCpu2Out = path.join(tempDir, "launch-cpu2.out");
  const cpu2Map = path.join(tempDir, "cpu2.map");
  await writeFile(ccxmlPath, "<configurations />");
  await writeFile(cpu1Out, "cpu1-image");
  await writeFile(cpu1ReloadOut, "cpu1-reload-image");
  await writeFile(cpu2Out, "cpu2-image");
  await writeFile(launchCpu1Out, "launch-cpu1-image");
  await writeFile(launchCpu2Out, "launch-cpu2-image");
  await writeFile(cpu2Map, [
    "MEMORY CONFIGURATION",
    "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX",
    "SECTION ALLOCATION MAP",
    ".text      0    00018000    000007bc"
  ].join("\n"));
  let sessionId: string | undefined;
  let launchSessionId: string | undefined;
  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map(tool => tool.name);
    assert(names.every(name => name.startsWith("c2000_")), "all exposed tools must use the c2000_ prefix");
    for (const tool of requiredTools) {
      assert(names.includes(tool), `missing required MCP tool: ${tool}`);
    }

    const contracts = structured(await client.callTool({ name: "c2000_getToolContracts", arguments: {} }));
    assert.equal(contracts.success, true);
    const continueContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_continue");
    assert(continueContract, "c2000_continue contract must be exposed");
    assert.equal(continueContract.inputScope, "core");
    assert.equal(continueContract.targetEffect, "execution-control");
    assert.deepEqual(continueContract.requiredInputFields.sort(), ["coreId", "sessionId"]);
    assert.deepEqual(continueContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(continueContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const preflightContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_getHardwarePreflight");
    assert(preflightContract, "c2000_getHardwarePreflight contract must be exposed");
    assert.equal(preflightContract.targetEffect, "host-read");
    const discoveryContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_discoverAcceptancePrograms");
    assert(discoveryContract, "c2000_discoverAcceptancePrograms contract must be exposed");
    assert.equal(discoveryContract.inputScope, "host");
    assert.equal(discoveryContract.targetEffect, "host-read");
    assert.deepEqual(discoveryContract.requiredInputFields, []);
    const readinessContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_getAcceptanceReadiness");
    assert(readinessContract, "c2000_getAcceptanceReadiness contract must be exposed");
    assert.equal(readinessContract.inputScope, "host");
    assert.equal(readinessContract.targetEffect, "host-read");
    assert.deepEqual(readinessContract.requiredInputFields, []);
    const ramOwnershipContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_analyzeRamOwnership");
    assert(ramOwnershipContract, "c2000_analyzeRamOwnership contract must be exposed");
    assert.equal(ramOwnershipContract.inputScope, "host");
    assert.equal(ramOwnershipContract.targetEffect, "host-read");
    assert.deepEqual(ramOwnershipContract.coreIdentityFields, ["maps[].coreId"]);
    assert.deepEqual(ramOwnershipContract.responseCoreIdentityFields, ["maps[].coreId", "ownershipActions[].targetCoreId"]);
    const boundaryContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_getDebugBoundary");
    assert(boundaryContract, "c2000_getDebugBoundary contract must be exposed");
    assert.equal(boundaryContract.inputScope, "host");
    assert.equal(boundaryContract.targetEffect, "host-read");
    const acceptanceEvidenceContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_getAcceptanceEvidence");
    assert(acceptanceEvidenceContract, "c2000_getAcceptanceEvidence contract must be exposed");
    assert.equal(acceptanceEvidenceContract.inputScope, "host");
    assert.equal(acceptanceEvidenceContract.targetEffect, "host-read");
    assert.deepEqual(acceptanceEvidenceContract.requiredInputFields, []);
    const loadProgramsContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_loadPrograms");
    assert(loadProgramsContract, "c2000_loadPrograms contract must be exposed");
    assert.equal(loadProgramsContract.targetEffect, "program-load");
    assert.deepEqual(loadProgramsContract.coreIdentityFields, ["programs[].coreId"]);
    assert.deepEqual(loadProgramsContract.responseCoreIdentityFields, ["results[].coreId", "results[].coreName"]);
    const snapshotContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_getMulticoreSnapshot");
    assert(snapshotContract, "c2000_getMulticoreSnapshot contract must be exposed");
    assert.deepEqual(snapshotContract.coreIdentityFields, ["coreIds[]"]);
    assert.deepEqual(snapshotContract.responseCoreIdentityFields, ["cores[].coreId", "cores[].coreName"]);
    const runPauseContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_verifyRunPauseIsolation");
    assert(runPauseContract, "c2000_verifyRunPauseIsolation contract must be exposed");
    assert.deepEqual(runPauseContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId"]);
    assert.deepEqual(runPauseContract.responseCoreIdentityFields, ["acceptanceSummary.steps[].commandCoreId", "acceptanceSummary.steps[].commandCoreName"]);
    const assignExpressionsContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_assignExpressions");
    assert(assignExpressionsContract, "c2000_assignExpressions contract must be exposed");
    assert.deepEqual(assignExpressionsContract.responseCoreIdentityFields, ["results[].coreId", "results[].coreName"]);
    const injectFaultsContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_injectFaults");
    assert(injectFaultsContract, "c2000_injectFaults contract must be exposed");
    assert.deepEqual(injectFaultsContract.responseCoreIdentityFields, ["results[].coreId", "results[].coreName"]);
    const compareExpressionsContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_compareExpressions");
    assert(compareExpressionsContract, "c2000_compareExpressions contract must be exposed");
    assert.deepEqual(compareExpressionsContract.responseCoreIdentityFields, ["comparisons[].left.coreId", "comparisons[].right.coreId"]);
    const waitForExpressionSetContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_waitForExpressionSet");
    assert(waitForExpressionSetContract, "c2000_waitForExpressionSet contract must be exposed");
    assert.deepEqual(waitForExpressionSetContract.responseCoreIdentityFields, ["conditions[].coreId"]);
    const diagnoseCpu2BootContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_diagnoseCpu2Boot");
    assert(diagnoseCpu2BootContract, "c2000_diagnoseCpu2Boot contract must be exposed");
    assert.deepEqual(diagnoseCpu2BootContract.responseCoreIdentityFields, ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]);
    const bootHandoffContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_diagnoseBootHandoff");
    assert(bootHandoffContract, "c2000_diagnoseBootHandoff contract must be exposed");
    assert.deepEqual(bootHandoffContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId"]);
    assert.deepEqual(bootHandoffContract.responseCoreIdentityFields, ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]);
    const ipcReadyContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_waitForIpcReady");
    assert(ipcReadyContract, "c2000_waitForIpcReady contract must be exposed");
    assert.deepEqual(ipcReadyContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"]);
    assert.deepEqual(ipcReadyContract.responseCoreIdentityFields, ["conditions[].coreId"]);
    const reloadResetRunContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_reloadResetRunToMain");
    assert(reloadResetRunContract, "c2000_reloadResetRunToMain contract must be exposed");
    assert.equal(reloadResetRunContract.inputScope, "core");
    assert.equal(reloadResetRunContract.targetEffect, "launch-workflow");
    assert.deepEqual(reloadResetRunContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(reloadResetRunContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const launchIpcAcceptanceWorkflowContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_launchAndRunIpcAcceptance");
    assert(launchIpcAcceptanceWorkflowContract, "c2000_launchAndRunIpcAcceptance contract must be exposed");
    assert.equal(launchIpcAcceptanceWorkflowContract.inputScope, "launch");
    assert.equal(launchIpcAcceptanceWorkflowContract.targetEffect, "launch-workflow");
    assert.deepEqual(launchIpcAcceptanceWorkflowContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"]);
    assert.deepEqual(launchIpcAcceptanceWorkflowContract.responseCoreIdentityFields, ["launch.coreMap[].coreId", "launch.created.cores[].coreId", "launch.connected.results[].coreId", "snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]);
    const ipcAcceptanceWorkflowContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_runIpcAcceptance");
    assert(ipcAcceptanceWorkflowContract, "c2000_runIpcAcceptance contract must be exposed");
    assert.equal(ipcAcceptanceWorkflowContract.inputScope, "launch");
    assert.equal(ipcAcceptanceWorkflowContract.targetEffect, "launch-workflow");
    assert.deepEqual(ipcAcceptanceWorkflowContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"]);
    assert.deepEqual(ipcAcceptanceWorkflowContract.responseCoreIdentityFields, ["snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]);
    const bootWorkflowContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_runBootHandoffDiagnosis");
    assert(bootWorkflowContract, "c2000_runBootHandoffDiagnosis contract must be exposed");
    assert.equal(bootWorkflowContract.inputScope, "launch");
    assert.equal(bootWorkflowContract.targetEffect, "launch-workflow");
    assert.deepEqual(bootWorkflowContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"]);
    const reloadWorkflowContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_runReloadAndDiagnose");
    assert(reloadWorkflowContract, "c2000_runReloadAndDiagnose contract must be exposed");
    assert.equal(reloadWorkflowContract.inputScope, "launch");
    assert.equal(reloadWorkflowContract.targetEffect, "launch-workflow");
    assert.deepEqual(reloadWorkflowContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"]);
    const fullBundleWorkflowContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_runFullDebugBundle");
    assert(fullBundleWorkflowContract, "c2000_runFullDebugBundle contract must be exposed");
    assert.equal(fullBundleWorkflowContract.inputScope, "launch");
    assert.equal(fullBundleWorkflowContract.targetEffect, "launch-workflow");
    assert.deepEqual(fullBundleWorkflowContract.coreIdentityFields, ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"]);
    const evaluateManyContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_evaluateMany");
    assert(evaluateManyContract, "c2000_evaluateMany contract must be exposed");
    assert.deepEqual(evaluateManyContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(evaluateManyContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const loadedProgramInfoContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_getLoadedProgramInfo");
    assert(loadedProgramInfoContract, "c2000_getLoadedProgramInfo contract must be exposed");
    assert.deepEqual(loadedProgramInfoContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(loadedProgramInfoContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const resolvePcContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_resolvePc");
    assert(resolvePcContract, "c2000_resolvePc contract must be exposed");
    assert.deepEqual(resolvePcContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(resolvePcContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const resolveAddressContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_resolveAddress");
    assert(resolveAddressContract, "c2000_resolveAddress contract must be exposed");
    assert.deepEqual(resolveAddressContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(resolveAddressContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const waitUntilExpressionContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_waitUntilExpression");
    assert(waitUntilExpressionContract, "c2000_waitUntilExpression contract must be exposed");
    assert.deepEqual(waitUntilExpressionContract.coreIdentityFields, ["coreId"]);
    assert.deepEqual(waitUntilExpressionContract.responseCoreIdentityFields, ["coreId", "coreName"]);
    const launchContract = (contracts.tools as Array<Record<string, any>>).find(tool => tool.name === "c2000_launchMulticoreDebug");
    assert(launchContract, "c2000_launchMulticoreDebug contract must be exposed");
    assertCoreIdentityFields(launchContract, [
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
    assertCoreIdentityFields(launchContract.responseCoreIdentityFields, [
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
    ]);

    const debugBoundary = structured(await client.callTool({ name: "c2000_getDebugBoundary", arguments: {} }));
    assert.equal(debugBoundary.success, true);
    assert.equal(debugBoundary.officialTiMcpDebugControlsUsed, false);
    assert.equal(debugBoundary.activeTargetAllowed, false);
    assert.equal(debugBoundary.continueSemantics, "non-blocking");
    assert.deepEqual(debugBoundary.requiredPerCoreInputs, ["sessionId", "coreId"]);
    assert.deepEqual(debugBoundary.coreIdConvention, { "0": "C28xx_CPU1", "2": "C28xx_CPU2" });
    assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_continue, "session.target.runAsynch()");
    assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_pause, "session.target.halt()");
    assert.equal(debugBoundary.perCoreDebugSessionMethods.c2000_loadProgram, "session.memory.loadProgram(programUri)");
    assert.equal(debugBoundary.realAdapter.defaultBridge, "PersistentDssBridge");
    assert.equal(debugBoundary.realAdapter.statelessDssCliBridgeUsedForDebugAutomation, false);
    assert.equal(debugBoundary.realAdapter.requiresResponseCoreIdentity, true);
    assert((debugBoundary.c2000DebugTools as string[]).includes("c2000_continue"));
    assert((debugBoundary.forbiddenOfficialDebugTools as string[]).includes("continue"));

    const acceptanceEvidence = structured(await client.callTool({ name: "c2000_getAcceptanceEvidence", arguments: {} }));
    assert.equal(acceptanceEvidence.success, true);
    assert.equal(acceptanceEvidence.evidence, "c2000_multicore_acceptance_evidence_plan");
    assert.equal(acceptanceEvidence.hostReadinessTool, "c2000_getAcceptanceReadiness");
    assert.equal(acceptanceEvidence.hardwareAcceptanceTool, "c2000_verifyRunPauseIsolation");
    assertAcceptanceRequirement(acceptanceEvidence, "continue_cpu1_only", "c2000_verifyRunPauseIsolation", {
      checkedCommandFields: ["coreId", "coreName"],
      checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
    });
    assertAcceptanceRequirement(acceptanceEvidence, "debug_tool_contracts", "c2000_getToolContracts", {
      expectedCoreDebugTools: ["c2000_connectTarget", "c2000_disconnectTarget", "c2000_runCore", "c2000_continue", "c2000_haltCore", "c2000_pause", "c2000_reset", "c2000_getTargetState", "c2000_loadProgram"],
      expectedRequiredInputs: ["sessionId", "coreId"],
      expectedResponseCoreIdentityFields: ["coreId", "coreName"]
    });
    assertAcceptanceRequirement(acceptanceEvidence, "multicore_tool_contracts", "c2000_getToolContracts", {
      expectedMulticoreToolContracts: [
        { name: "c2000_loadPrograms", inputScope: "batch", requiredInputFields: ["sessionId", "programs"], coreIdentityFields: ["programs[].coreId"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_connectCores", inputScope: "batch", requiredInputFields: ["sessionId", "coreIds"], coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_haltCores", inputScope: "batch", requiredInputFields: ["sessionId", "coreIds"], coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_resetCores", inputScope: "batch", requiredInputFields: ["sessionId", "coreIds"], coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_runCores", inputScope: "batch", requiredInputFields: ["sessionId", "coreIds"], coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_getMulticoreSnapshot", inputScope: "session", requiredInputFields: ["sessionId"], coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: ["cores[].coreId", "cores[].coreName"] }
      ]
    });
    assertAcceptanceRequirement(acceptanceEvidence, "core_read_tool_contracts", "c2000_getToolContracts", {
      expectedCoreReadToolContracts: [
        { name: "c2000_evaluateMany", inputScope: "core", targetEffect: "target-read", requiredInputFields: ["sessionId", "coreId", "expressions"], coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
        { name: "c2000_getLoadedProgramInfo", inputScope: "core", targetEffect: "target-read", requiredInputFields: ["sessionId", "coreId"], coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
        { name: "c2000_resolvePc", inputScope: "core", targetEffect: "target-read", requiredInputFields: ["sessionId", "coreId"], coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
        { name: "c2000_resolveAddress", inputScope: "core", targetEffect: "target-read", requiredInputFields: ["sessionId", "coreId", "address"], coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
        { name: "c2000_waitUntilExpression", inputScope: "core", targetEffect: "target-read", requiredInputFields: ["sessionId", "coreId", "expression", "expected", "timeoutMs"], coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] }
      ]
    });
    assertAcceptanceRequirement(acceptanceEvidence, "advanced_automation_contracts", "c2000_getToolContracts", {
      expectedAdvancedAutomationToolContracts: [
        { name: "c2000_analyzeRamOwnership", inputScope: "host", targetEffect: "host-read", requiredInputFields: ["maps"], coreIdentityFields: ["maps[].coreId"], responseCoreIdentityFields: ["maps[].coreId", "ownershipActions[].targetCoreId"] },
        { name: "c2000_assignExpressions", inputScope: "batch", targetEffect: "memory-write", requiredInputFields: ["sessionId", "assignments"], coreIdentityFields: ["assignments[].coreId"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_injectFaults", inputScope: "batch", targetEffect: "memory-write", requiredInputFields: ["sessionId", "faults"], coreIdentityFields: ["faults[].coreId"], responseCoreIdentityFields: ["results[].coreId", "results[].coreName"] },
        { name: "c2000_compareExpressions", inputScope: "session", targetEffect: "target-read", requiredInputFields: ["sessionId", "comparisons"], coreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"], responseCoreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"] },
        { name: "c2000_waitForExpressionSet", inputScope: "session", targetEffect: "target-read", requiredInputFields: ["sessionId", "conditions", "timeoutMs"], coreIdentityFields: ["conditions[].coreId"], responseCoreIdentityFields: ["conditions[].coreId"] },
        { name: "c2000_diagnoseCpu2Boot", inputScope: "session", targetEffect: "target-read", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"] },
        { name: "c2000_diagnoseBootHandoff", inputScope: "session", targetEffect: "target-read", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId"] },
        { name: "c2000_waitForIpcReady", inputScope: "session", targetEffect: "target-read", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "timeoutMs"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"], responseCoreIdentityFields: ["conditions[].coreId"] },
        { name: "c2000_reloadResetRunToMain", inputScope: "core", targetEffect: "launch-workflow", requiredInputFields: ["sessionId", "coreId", "programUri"], coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
        { name: "c2000_launchAndRunIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", requiredInputFields: ["cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "timeoutMs"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: ["launch.coreMap[].coreId", "launch.created.cores[].coreId", "launch.connected.results[].coreId", "snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"] },
        { name: "c2000_runIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "timeoutMs"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: ["snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"] },
        { name: "c2000_runBootHandoffDiagnosis", inputScope: "launch", targetEffect: "launch-workflow", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"], responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId", "expressions[].coreId", "pc[].coreId"] },
        { name: "c2000_runReloadAndDiagnose", inputScope: "launch", targetEffect: "launch-workflow", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"], responseCoreIdentityFields: ["snapshot.cores[].coreId", "wait.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"] },
        { name: "c2000_runFullDebugBundle", inputScope: "launch", targetEffect: "launch-workflow", requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "outputDir"], coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"], responseCoreIdentityFields: ["snapshot.cores[].coreId", "loadedPrograms[].coreId", "expressions[].coreId", "pc[].coreId", "ramOwnership.maps[].coreId", "bootHandoff.cpu1.coreId", "bootHandoff.cpu2.coreId"] },
        {
          name: "c2000_launchMulticoreDebug",
          inputScope: "launch",
          targetEffect: "launch-workflow",
          requiredInputFields: ["cores"],
          coreIdentityFields: [
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
          ],
          responseCoreIdentityFields: [
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
          ]
        }
      ]
    });
    assertAcceptanceRequirement(acceptanceEvidence, "multicore_snapshot", "c2000_getMulticoreSnapshot", {
      expectedCoreFields: ["coreName", "connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
    });
    assertAcceptanceRequirement(acceptanceEvidence, "no_ccs_ui_focus", "c2000_getDebugBoundary");

    const preflight = structured(await client.callTool({ name: "c2000_getHardwarePreflight", arguments: {} }));
    assert.equal(preflight.success, true);
    assert.equal(typeof preflight.xdsdfuPath, "string");
    assert.equal(typeof preflight.xdsdfu?.ok, "boolean");
    assert(Array.isArray(preflight.debugProcesses));

    const programDiscovery = structured(await client.callTool({
      name: "c2000_discoverAcceptancePrograms",
      arguments: { cpu1Program: cpu1Out, cpu2Program: cpu2Out, searchRoots: [tempDir], maxDepth: 1 }
    }));
    assert.equal(programDiscovery.success, true);
    assert.equal(programDiscovery.cpu1.selected, cpu1Out);
    assert.equal(programDiscovery.cpu1.source, "env");
    assert.equal(programDiscovery.cpu2.selected, cpu2Out);
    assert.equal(programDiscovery.cpu2.source, "env");
    assert.deepEqual(programDiscovery.searchRoots, [tempDir]);

    const ramOwnership = structured(await client.callTool({
      name: "c2000_analyzeRamOwnership",
      arguments: { maps: [{ coreId: 2, coreName: "C28xx_CPU2", mapPath: cpu2Map }] }
    }));
    assert.equal(ramOwnership.success, true);
    assert.equal(ramOwnership.ownershipActions[0].targetCoreId, 2);
    assert.equal(ramOwnership.ownershipActions[0].memoryRegion, "RAMGS4");

    const acceptanceReadiness = structured(await client.callTool({
      name: "c2000_getAcceptanceReadiness",
      arguments: { ccxmlPath, cpu1Program: cpu1Out, cpu2Program: cpu2Out, searchRoots: [tempDir], maxDepth: 1 }
    }));
    assert.equal(acceptanceReadiness.success, true);
    assert.equal(typeof acceptanceReadiness.readyForHardwareAcceptance, "boolean");
    assert(Array.isArray(acceptanceReadiness.blockers));
    assert.equal(acceptanceReadiness.programDiscovery.cpu1.selected, cpu1Out);
    assert.equal(acceptanceReadiness.programDiscovery.cpu2.selected, cpu2Out);
    assert.equal(acceptanceReadiness.checks.ccxml.ok, true);
    assert.equal(acceptanceReadiness.checks.cpu1Program.ok, true);
    assert.equal(acceptanceReadiness.checks.cpu2Program.ok, true);
    assert.equal(acceptanceReadiness.debugBoundary.officialTiMcpDebugControlsUsed, false);
    assert.equal(acceptanceReadiness.debugBoundary.activeTargetAllowed, false);
    assert.equal(acceptanceReadiness.uiIndependenceEvidence.evidence, "c2000_debug_boundary_ui_independence");
    assert.equal(acceptanceReadiness.uiIndependenceEvidence.officialTiMcpDebugControlsUsed, false);
    assert.equal(acceptanceReadiness.uiIndependenceEvidence.activeTargetAllowed, false);
    assert.equal(acceptanceReadiness.uiIndependenceEvidence.uiFocusRequired, false);
    assert.equal(acceptanceReadiness.uiIndependenceEvidence.selectedCpuRequired, false);
    assert.deepEqual(acceptanceReadiness.uiIndependenceEvidence.requiredPerCoreInputs, ["sessionId", "coreId"]);

    const created = structured(await client.callTool({
      name: "c2000_createDebugSession",
      arguments: { sessionName: "mcp-stdio-smoke" }
    }));
    assert.equal(created.success, true);
    assert.equal(typeof created.sessionId, "string");
    sessionId = created.sessionId as string;

    const topology = structured(await client.callTool({
      name: "c2000_getSessionTopology",
      arguments: { sessionId }
    }));
    assert.equal(topology.success, true);
    assert.equal(typeof topology.adapterSessionId, "string");
    assert.equal(topology.adapterName, "mock");
    assert.equal(topology.debugSessionRoute, "sessionId -> adapterSessionId -> coreId -> DebugSession");
    assert.deepEqual(topology.cores.map((core: Record<string, any>) => ({
      coreId: core.coreId,
      coreName: core.coreName,
      corePattern: core.corePattern,
      targetSelector: core.targetSelector,
      debugSessionKey: core.debugSessionKey
    })), [
      { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", targetSelector: "C28xx_CPU1", debugSessionKey: `${topology.adapterSessionId}:0` },
      { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", targetSelector: "C28xx_CPU2", debugSessionKey: `${topology.adapterSessionId}:2` }
    ]);

    const connected = structured(await client.callTool({
      name: "c2000_connectCores",
      arguments: { sessionId, coreIds: [0, 2] }
    }));
    assert.equal(connected.success, true);

    const loaded = structured(await client.callTool({
      name: "c2000_loadPrograms",
      arguments: {
        sessionId,
        programs: [
          { coreId: 0, programUri: cpu1Out },
          { coreId: 2, programUri: cpu2Out }
        ]
      }
    }));
    assert.equal(loaded.success, true);

    const cpu1Run = structured(await client.callTool({
      name: "c2000_continue",
      arguments: { sessionId, coreId: 0 }
    }));
    assert.equal(cpu1Run.success, true);
    assert.equal(cpu1Run.coreId, 0);
    assert.equal(cpu1Run.state, "Running");

    const cpu1State = structured(await client.callTool({
      name: "c2000_getTargetState",
      arguments: { sessionId, coreId: 0 }
    }));
    assert.equal(cpu1State.success, true);
    assert.equal(cpu1State.coreId, 0);
    assert.equal(cpu1State.state, "Running");

    let snapshot = structured(await client.callTool({
      name: "c2000_getMulticoreSnapshot",
      arguments: { sessionId }
    }));
    assertCoreState(snapshot, 0, "Running");
    assertCoreState(snapshot, 2, "Halted");
    assertCoreLoadedProgram(snapshot, 0, cpu1Out);
    assertCoreLoadedProgram(snapshot, 2, cpu2Out);

    const cpu1Pause = structured(await client.callTool({
      name: "c2000_pause",
      arguments: { sessionId, coreId: 0 }
    }));
    assert.equal(cpu1Pause.success, true);
    assert.equal(cpu1Pause.coreId, 0);
    assert.equal(cpu1Pause.state, "Halted");

    const cpu1RunAlias = structured(await client.callTool({
      name: "c2000_runCore",
      arguments: { sessionId, coreId: 0 }
    }));
    assert.equal(cpu1RunAlias.success, true);
    assert.equal(cpu1RunAlias.coreId, 0);
    assert.equal(cpu1RunAlias.coreName, "C28xx_CPU1");
    assert.equal(cpu1RunAlias.state, "Running");

    const cpu1HaltAlias = structured(await client.callTool({
      name: "c2000_haltCore",
      arguments: { sessionId, coreId: 0 }
    }));
    assert.equal(cpu1HaltAlias.success, true);
    assert.equal(cpu1HaltAlias.coreId, 0);
    assert.equal(cpu1HaltAlias.coreName, "C28xx_CPU1");
    assert.equal(cpu1HaltAlias.state, "Halted");

    const cpu1Reset = structured(await client.callTool({
      name: "c2000_reset",
      arguments: { sessionId, coreId: 0, resetType: "cpu" }
    }));
    assert.equal(cpu1Reset.success, true);
    assert.equal(cpu1Reset.coreId, 0);
    assert.equal(cpu1Reset.state, "Halted");

    const cpu1Reload = structured(await client.callTool({
      name: "c2000_loadProgram",
      arguments: { sessionId, coreId: 0, programUri: cpu1ReloadOut }
    }));
    assert.equal(cpu1Reload.success, true);
    assert.equal(cpu1Reload.coreId, 0);
    assert.equal(cpu1Reload.programUri, cpu1ReloadOut);
    snapshot = structured(await client.callTool({
      name: "c2000_getMulticoreSnapshot",
      arguments: { sessionId }
    }));
    assertCoreState(snapshot, 0, "Halted");
    assertCoreState(snapshot, 2, "Halted");
    assertCoreLoadedProgram(snapshot, 0, cpu1ReloadOut);
    assertCoreLoadedProgram(snapshot, 2, cpu2Out);

    const cpu2Run = structured(await client.callTool({
      name: "c2000_continue",
      arguments: { sessionId, coreId: 2 }
    }));
    assert.equal(cpu2Run.success, true);
    assert.equal(cpu2Run.coreId, 2);
    assert.equal(cpu2Run.state, "Running");

    snapshot = structured(await client.callTool({
      name: "c2000_getMulticoreSnapshot",
      arguments: { sessionId }
    }));
    assertCoreState(snapshot, 0, "Halted");
    assertCoreState(snapshot, 2, "Running");
    assertCoreLoadedProgram(snapshot, 0, cpu1ReloadOut);
    assertCoreLoadedProgram(snapshot, 2, cpu2Out);

    const cpu2Pause = structured(await client.callTool({
      name: "c2000_pause",
      arguments: { sessionId, coreId: 2 }
    }));
    assert.equal(cpu2Pause.success, true);
    assert.equal(cpu2Pause.coreId, 2);
    assert.equal(cpu2Pause.state, "Halted");

    const cpu2Disconnect = structured(await client.callTool({
      name: "c2000_disconnectTarget",
      arguments: { sessionId, coreId: 2 }
    }));
    assert.equal(cpu2Disconnect.success, true);
    assert.equal(cpu2Disconnect.coreId, 2);
    assert.equal(cpu2Disconnect.connected, false);
    snapshot = structured(await client.callTool({
      name: "c2000_getMulticoreSnapshot",
      arguments: { sessionId }
    }));
    assertCoreState(snapshot, 0, "Halted");
    assertCoreState(snapshot, 2, "Disconnected");
    assertCoreLoadedProgram(snapshot, 0, cpu1ReloadOut);
    assertCoreLoadedProgram(snapshot, 2, cpu2Out);

    const reconnected = structured(await client.callTool({
      name: "c2000_connectCores",
      arguments: { sessionId, coreIds: [0, 2] }
    }));
    assert.equal(reconnected.success, true);
    const halted = structured(await client.callTool({
      name: "c2000_pause",
      arguments: { sessionId, coreId: 2 }
    }));
    assert.equal(halted.success, true);
    assert.equal(halted.coreId, 2);
    assert.equal(halted.state, "Halted");

    const batchAssignments = structured(await client.callTool({
      name: "c2000_assignExpressions",
      arguments: {
        sessionId,
        assignments: [
          { coreId: 0, expression: "g_ulHybrid30kBatchFault", value: 1 },
          { coreId: 2, expression: "g_ulHybrid30kBatchFault", value: 2 }
        ]
      }
    }));
    assert.equal(batchAssignments.success, true);
    assert.deepEqual(batchAssignments.results.map((item: Record<string, any>) => ({
      coreId: item.coreId,
      expression: item.expression,
      assignedValue: item.assignedValue,
      success: item.success
    })), [
      { coreId: 0, expression: "g_ulHybrid30kBatchFault", assignedValue: "1", success: true },
      { coreId: 2, expression: "g_ulHybrid30kBatchFault", assignedValue: "2", success: true }
    ]);
    const batchAssignmentReadbackCpu1 = structured(await client.callTool({
      name: "c2000_evaluateMany",
      arguments: { sessionId, coreId: 0, expressions: ["g_ulHybrid30kBatchFault"] }
    }));
    const batchAssignmentReadbackCpu2 = structured(await client.callTool({
      name: "c2000_evaluateMany",
      arguments: { sessionId, coreId: 2, expressions: ["g_ulHybrid30kBatchFault"] }
    }));
    assertCoreReadIdentity(batchAssignmentReadbackCpu1, 0);
    assertCoreReadIdentity(batchAssignmentReadbackCpu2, 2);
    assert.equal(batchAssignmentReadbackCpu1.results[0].value, "1");
    assert.equal(batchAssignmentReadbackCpu2.results[0].value, "2");

    const injectedFaults = structured(await client.callTool({
      name: "c2000_injectFaults",
      arguments: {
        sessionId,
        faults: [
          { label: "cpu1-injected-fault", coreId: 0, expression: "g_ulHybrid30kInjectedFault", value: 11 },
          { label: "cpu2-injected-fault", coreId: 2, expression: "g_ulHybrid30kInjectedFault", value: 22 }
        ]
      }
    }));
    assert.equal(injectedFaults.success, true);
    assert.deepEqual(injectedFaults.summary, { total: 2, succeeded: 2, failed: 0 });
    assert.deepEqual(injectedFaults.results.map((item: Record<string, any>) => ({
      label: item.label,
      coreId: item.coreId,
      expression: item.expression,
      assignedValue: item.assignedValue,
      success: item.success
    })), [
      { label: "cpu1-injected-fault", coreId: 0, expression: "g_ulHybrid30kInjectedFault", assignedValue: "11", success: true },
      { label: "cpu2-injected-fault", coreId: 2, expression: "g_ulHybrid30kInjectedFault", assignedValue: "22", success: true }
    ]);
    const injectedFaultReadbackCpu1 = structured(await client.callTool({
      name: "c2000_evaluateMany",
      arguments: { sessionId, coreId: 0, expressions: ["g_ulHybrid30kInjectedFault"] }
    }));
    const injectedFaultReadbackCpu2 = structured(await client.callTool({
      name: "c2000_evaluateMany",
      arguments: { sessionId, coreId: 2, expressions: ["g_ulHybrid30kInjectedFault"] }
    }));
    assertCoreReadIdentity(injectedFaultReadbackCpu1, 0);
    assertCoreReadIdentity(injectedFaultReadbackCpu2, 2);
    assert.equal(injectedFaultReadbackCpu1.results[0].value, "11");
    assert.equal(injectedFaultReadbackCpu2.results[0].value, "22");

    const ipcReadyAssignments = structured(await client.callTool({
      name: "c2000_assignExpressions",
      arguments: {
        sessionId,
        assignments: [
          { coreId: 0, expression: "g_emHybrid30kCpu1Stage", value: 1 },
          { coreId: 0, expression: "g_ulHybrid30kIpcPass", value: 1 },
          { coreId: 0, expression: "g_ulHybrid30kMsgRamPass", value: 1 },
          { coreId: 0, expression: "g_ulHybrid30kParamPass", value: 1 },
          { coreId: 2, expression: "g_emHybrid30kCpu2Stage", value: 1 }
        ]
      }
    }));
    assert.equal(ipcReadyAssignments.success, true);
    const ipcReady = structured(await client.callTool({
      name: "c2000_waitForIpcReady",
      arguments: { sessionId, cpu1CoreId: 0, cpu2CoreId: 2, timeoutMs: 50, intervalMs: 5 }
    }));
    assert.equal(ipcReady.success, true);
    assert.equal(ipcReady.matched, true);
    assert(ipcReady.conditions.every((condition: Record<string, any>) => condition.matched === true));
    const bootHandoff = structured(await client.callTool({
      name: "c2000_diagnoseBootHandoff",
      arguments: { sessionId, cpu1CoreId: 0, cpu2CoreId: 2, maps: [{ coreId: 2, coreName: "C28xx_CPU2", mapPath: cpu2Map }] }
    }));
    assert.equal(bootHandoff.success, true);
    assert.equal(bootHandoff.cpu1.coreId, 0);
    assert.equal(bootHandoff.cpu2.coreId, 2);
    assert.equal(bootHandoff.verdict.ready, true);
    assert.equal(bootHandoff.ramOwnership.ownershipActions[0].targetCoreId, 2);

    const cpu1LoadedProgramInfo = structured(await client.callTool({
      name: "c2000_getLoadedProgramInfo",
      arguments: { sessionId, coreId: 0 }
    }));
    const cpu2LoadedProgramInfo = structured(await client.callTool({
      name: "c2000_getLoadedProgramInfo",
      arguments: { sessionId, coreId: 2 }
    }));
    assertCoreReadIdentity(cpu1LoadedProgramInfo, 0);
    assertCoreReadIdentity(cpu2LoadedProgramInfo, 2);
    assert.equal(cpu1LoadedProgramInfo.programUri, cpu1ReloadOut);
    assert.equal(cpu2LoadedProgramInfo.programUri, cpu2Out);

    const cpu1ResolvedPc = structured(await client.callTool({
      name: "c2000_resolvePc",
      arguments: { sessionId, coreId: 0 }
    }));
    const cpu2ResolvedPc = structured(await client.callTool({
      name: "c2000_resolvePc",
      arguments: { sessionId, coreId: 2 }
    }));
    assertCoreReadIdentity(cpu1ResolvedPc, 0);
    assertCoreReadIdentity(cpu2ResolvedPc, 2);
    assert.equal(typeof cpu1ResolvedPc.pc, "string");
    assert.equal(typeof cpu2ResolvedPc.pc, "string");

    const cpu1ResolvedAddress = structured(await client.callTool({
      name: "c2000_resolveAddress",
      arguments: { sessionId, coreId: 0, address: "0x00C4E1" }
    }));
    assertCoreReadIdentity(cpu1ResolvedAddress, 0);
    assert.equal(cpu1ResolvedAddress.address, "0x00C4E1");

    const cpu2WaitUntilExpression = structured(await client.callTool({
      name: "c2000_waitUntilExpression",
      arguments: {
        sessionId,
        coreId: 2,
        expression: "g_ulHybrid30kInjectedFault",
        expected: 22,
        timeoutMs: 50,
        intervalMs: 5
      }
    }));
    assertCoreReadIdentity(cpu2WaitUntilExpression, 2);
    assert.equal(cpu2WaitUntilExpression.matched, true);

    const runPauseIsolation = structured(await client.callTool({
      name: "c2000_verifyRunPauseIsolation",
      arguments: { sessionId, settleMs: 1 }
    }));
    assert.equal(runPauseIsolation.success, true);
    assertAcceptanceSummary(runPauseIsolation.acceptanceSummary);

    const reloadResetRun = structured(await client.callTool({
      name: "c2000_reloadResetRunToMain",
      arguments: { sessionId, coreId: 0, programUri: cpu1ReloadOut, resetType: "cpu", settleMs: 1 }
    }));
    assert.equal(reloadResetRun.success, true);
    assert.equal(reloadResetRun.coreId, 0);
    assert.equal(reloadResetRun.coreName, "C28xx_CPU1");
    assert.equal(reloadResetRun.finalState.state, "Running");
    assert.equal(reloadResetRun.runToMainSupported, false);
    assert.equal(reloadResetRun.runToMainAchieved, false);
    assert(reloadResetRun.unsupportedReason.includes("breakpoint"));

    const closed = structured(await client.callTool({
      name: "c2000_closeDebugSession",
      arguments: { sessionId }
    }));
    assert.equal(closed.success, true);
    sessionId = undefined;

    const launch = structured(await client.callTool({
      name: "c2000_launchMulticoreDebug",
      arguments: {
        sessionName: "mcp-stdio-launch-smoke",
        programDiscovery: {
          enabled: true,
          cpu1Program: launchCpu1Out,
          cpu2Program: launchCpu2Out,
          searchRoots: [tempDir]
        },
        cores: [
          { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", connect: true, load: true, haltAtEntry: true },
          { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", connect: true, load: true, haltAtEntry: true }
        ],
        postLaunchActions: {
          assignExpressions: [
            { coreId: 0, expression: "g_ulHybrid30kLaunchBatchFault", value: 7 },
            { coreId: 2, expression: "g_ulHybrid30kLaunchBatchFault", value: 7 }
          ],
          injectFaults: [
            { label: "launch-cpu1-injected-fault", coreId: 0, expression: "g_ulHybrid30kLaunchInjectedFault", value: 9 },
            { label: "launch-cpu2-injected-fault", coreId: 2, expression: "g_ulHybrid30kLaunchInjectedFault", value: 9 }
          ]
        },
        postLaunchChecks: {
          compareExpressions: [
            {
              label: "launch-batch-fault-sync",
              left: { coreId: 0, expression: "g_ulHybrid30kLaunchBatchFault" },
              right: { coreId: 2, expression: "g_ulHybrid30kLaunchBatchFault" }
            },
            {
              label: "launch-injected-fault-sync",
              left: { coreId: 0, expression: "g_ulHybrid30kLaunchInjectedFault" },
              right: { coreId: 2, expression: "g_ulHybrid30kLaunchInjectedFault" }
            }
          ],
          verifyRunPauseIsolation: { settleMs: 1 }
        }
      }
    }));
    assert.equal(launch.success, true);
    assert.equal(typeof launch.sessionId, "string");
    launchSessionId = launch.sessionId as string;
    assert.equal(launch.programDiscovery.cpu1.selected, launchCpu1Out);
    assert.equal(launch.programDiscovery.cpu2.selected, launchCpu2Out);
    assertCoreState(launch.snapshot, 0, "Halted");
    assertCoreState(launch.snapshot, 2, "Halted");
    assertCoreLoadedProgram(launch.snapshot, 0, launchCpu1Out);
    assertCoreLoadedProgram(launch.snapshot, 2, launchCpu2Out);
    assert.equal(launch.postLaunchActions.assignExpressions.results[0].assignedValue, "7");
    assert.equal(launch.postLaunchActions.assignExpressions.results[1].assignedValue, "7");
    assert.equal(launch.postLaunchActions.injectFaults.summary.failed, 0);
    assert.equal(launch.postLaunchActions.injectFaults.results[0].assignedValue, "9");
    assert.equal(launch.postLaunchActions.injectFaults.results[1].assignedValue, "9");
    assert.equal(launch.postLaunchChecks.compareExpressions.matched, true);
    assertAcceptanceSummary(launch.postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary);

    const launchClosed = structured(await client.callTool({
      name: "c2000_closeDebugSession",
      arguments: { sessionId: launchSessionId }
    }));
    assert.equal(launchClosed.success, true);
    launchSessionId = undefined;

    console.log(JSON.stringify({
      success: true,
      checkedTools: requiredTools,
      serverVersion: client.getServerVersion(),
      loadedPrograms: { cpu1Out, cpu1ReloadOut, cpu2Out, launchCpu1Out, launchCpu2Out },
      programDiscovery,
       acceptanceReadiness: {
         readyForHardwareAcceptance: acceptanceReadiness.readyForHardwareAcceptance,
         blockers: acceptanceReadiness.blockers,
         uiIndependenceEvidence: acceptanceReadiness.uiIndependenceEvidence
       },
       preflight: {
        xdsdfuPath: preflight.xdsdfuPath,
        xdsdfuOk: preflight.xdsdfu.ok,
        debugProcessCount: preflight.debugProcesses.length
       },
       debugBoundary,
       acceptanceEvidence
     }, null, 2));
  } finally {
    if (sessionId) {
      await client.callTool({ name: "c2000_closeDebugSession", arguments: { sessionId } }).catch(() => undefined);
    }
    if (launchSessionId) {
      await client.callTool({ name: "c2000_closeDebugSession", arguments: { sessionId: launchSessionId } }).catch(() => undefined);
    }
    await client.close();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) {
      process.stderr.write(`${stderr}\n`);
    }
  }
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  assert(result.structuredContent && typeof result.structuredContent === "object", "tool result must include structuredContent");
  return result.structuredContent as Record<string, any>;
}

function assertCoreState(snapshot: Record<string, any>, coreId: number, state: string) {
  assertSnapshotSuccess(snapshot);
  const core = findSnapshotCore(snapshot, coreId);
  assertSnapshotCoreIdentity(snapshot, coreId);
  assert.equal(core.state, state);
}

function assertCoreLoadedProgram(snapshot: Record<string, any>, coreId: number, programUri: string) {
  assertSnapshotSuccess(snapshot);
  const core = findSnapshotCore(snapshot, coreId);
  assertSnapshotCoreIdentity(snapshot, coreId);
  assert.equal(core.loadedProgram, programUri);
  assert.equal(core.loadedProgramInfo?.programUri, programUri);
  assert.equal(core.loadedProgramInfo?.coreId, coreId);
  assert.equal(typeof core.loadedProgramInfo?.sha256, "string");
  assert.equal(core.loadedProgramInfo.sha256.length, 64);
  assert.equal(core.loadedProgramInfo?.symbolsLoaded, true);
}

function findSnapshotCore(snapshot: Record<string, any>, coreId: number) {
  assertSnapshotSuccess(snapshot);
  const core = (snapshot.cores as Array<Record<string, any>>).find(candidate => candidate.coreId === coreId);
  assert(core, `snapshot is missing core ${coreId}`);
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

function assertSnapshotSuccess(snapshot: Record<string, any>) {
  if ("success" in snapshot) {
    assert.equal(snapshot.success, true);
  }
  assert(Array.isArray(snapshot.cores), "snapshot must include cores");
}

function assertCoreReadIdentity(result: Record<string, any>, coreId: number) {
  assert.equal(result.success, true);
  assert.equal(result.coreId, coreId);
  assert.equal(result.coreName, expectedCoreName(coreId));
}

function assertAcceptanceRequirement(
  evidence: Record<string, any>,
  id: string,
  proofTool: string,
  expected?: {
    checkedCommandFields?: string[];
    checkedPeerFields?: string[];
    expectedCoreFields?: string[];
    expectedCoreDebugTools?: string[];
    expectedRequiredInputs?: string[];
    expectedResponseCoreIdentityFields?: string[];
    expectedMulticoreToolContracts?: Array<Record<string, any>>;
    expectedCoreReadToolContracts?: Array<Record<string, any>>;
    expectedAdvancedAutomationToolContracts?: Array<Record<string, any>>;
  }
) {
  assert(Array.isArray(evidence.requirements), "acceptanceEvidence.requirements must be an array");
  const requirement = (evidence.requirements as Array<Record<string, any>>).find(candidate => candidate.id === id);
  assert(requirement, `acceptance evidence is missing requirement ${id}`);
  assert.equal(requirement.proofTool, proofTool);
  if (expected?.checkedCommandFields) {
    assert.deepEqual(requirement.checkedCommandFields, expected.checkedCommandFields);
  }
  if (expected?.checkedPeerFields) {
    assert.deepEqual(requirement.checkedPeerFields, expected.checkedPeerFields);
  }
  if (expected?.expectedCoreFields) {
    assert.deepEqual(requirement.expectedCoreFields, expected.expectedCoreFields);
  }
  if (expected?.expectedCoreDebugTools) {
    assert.deepEqual(requirement.expectedCoreDebugTools, expected.expectedCoreDebugTools);
  }
  if (expected?.expectedRequiredInputs) {
    assert.deepEqual(requirement.expectedRequiredInputs, expected.expectedRequiredInputs);
  }
  if (expected?.expectedResponseCoreIdentityFields) {
    assert.deepEqual(requirement.expectedResponseCoreIdentityFields, expected.expectedResponseCoreIdentityFields);
  }
  if (expected?.expectedMulticoreToolContracts) {
    assert.deepEqual(requirement.expectedMulticoreToolContracts, expected.expectedMulticoreToolContracts);
  }
  if (expected?.expectedCoreReadToolContracts) {
    assert.deepEqual(requirement.expectedCoreReadToolContracts, expected.expectedCoreReadToolContracts);
  }
  if (expected?.expectedAdvancedAutomationToolContracts) {
    assert.deepEqual(requirement.expectedAdvancedAutomationToolContracts, expected.expectedAdvancedAutomationToolContracts);
  }
}

function assertCoreIdentityFields(actual: Record<string, any> | unknown, expected: string[]) {
  if (Array.isArray(actual)) {
    assert.deepEqual(actual, expected);
    return;
  }
  assert.deepEqual((actual as Record<string, any>).coreIdentityFields, expected);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

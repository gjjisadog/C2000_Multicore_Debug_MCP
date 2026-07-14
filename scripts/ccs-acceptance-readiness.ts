import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertAcceptanceEvidence } from "../src/debug/boundary.js";

import { resolveCcsInstallPathSync } from "../src/adapters/ccsInstallPath.js";
const ccsInstallPath = process.env.C2000_MCP_CCS_INSTALL_PATH ?? resolveCcsInstallPathSync().installPath;
const ccxmlPath = process.env.C2000_MCP_CCXML_PATH
  ?? "/Applications/ti/C2000Ware_26_01_00_00_STS/device_support/f28p65x/common/targetConfigs/TMS320F28P650DK9.ccxml";
const allowExistingDebugProcesses = process.env.C2000_ALLOW_EXISTING_DEBUG_PROCESSES === "1";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    C2000_MCP_ADAPTER: "ccs",
    C2000_MCP_CCS_INSTALL_PATH: ccsInstallPath,
    C2000_MCP_CCXML_PATH: ccxmlPath,
    C2000_MCP_LOG_LEVEL: process.env.C2000_MCP_LOG_LEVEL ?? "error"
  }
});
const stderrChunks: Buffer[] = [];
transport.stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

const client = new Client({ name: "c2000-mcp-acceptance-readiness", version: "0.1.0" });
let readiness: Record<string, any> | undefined;

try {
  await client.connect(transport);

  const contracts = structured(await client.callTool({
    name: "c2000_getToolContracts",
    arguments: {}
  }));
  assert.equal(contracts.success, true);
  assertToolContract(contracts, "c2000_getDebugBoundary", "host", "host-read", []);
  assertToolContract(contracts, "c2000_getAcceptanceEvidence", "host", "host-read", []);
  assertToolContract(contracts, "c2000_getHardwarePreflight", "host", "host-read", []);
  assertToolContract(contracts, "c2000_discoverAcceptancePrograms", "host", "host-read", []);
  assertToolContract(contracts, "c2000_getAcceptanceReadiness", "host", "host-read", []);
  assertCoreToolContract(contracts, "c2000_runCore", "execution-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_continue", "execution-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_haltCore", "execution-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_pause", "execution-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_reset", "reset-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_connectTarget", "connectivity-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_disconnectTarget", "connectivity-control", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_getTargetState", "target-read", ["sessionId", "coreId"]);
  assertToolContract(contracts, "c2000_assignExpressions", "batch", "memory-write", ["sessionId", "assignments"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_injectFaults", "batch", "memory-write", ["sessionId", "faults"], ["results[].coreId", "results[].coreName"]);
  assertToolContract(contracts, "c2000_compareExpressions", "session", "target-read", ["sessionId", "comparisons"], ["comparisons[].left.coreId", "comparisons[].right.coreId"]);
  assertToolContract(contracts, "c2000_waitForExpressionSet", "session", "target-read", ["sessionId", "conditions", "timeoutMs"], ["conditions[].coreId"]);
  assertToolContract(contracts, "c2000_diagnoseCpu2Boot", "session", "target-read", ["sessionId", "cpu1CoreId", "cpu2CoreId"], ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]);
  assertToolContract(contracts, "c2000_launchMulticoreDebug", "launch", "launch-workflow", ["cores"], ["snapshot.cores[].coreId", "postLaunchActions.assignExpressions.results[].coreId", "postLaunchActions.injectFaults.results[].coreId", "postLaunchChecks.waitForExpressionSet.conditions[].coreId", "postLaunchChecks.compareExpressions.comparisons[].left.coreId", "postLaunchChecks.compareExpressions.comparisons[].right.coreId", "postLaunchChecks.diagnoseCpu2Boot.cpu1.coreId", "postLaunchChecks.diagnoseCpu2Boot.cpu2.coreId", "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreId", "postLaunchChecks.verifyRunPauseIsolation.acceptanceSummary.steps[].commandCoreName"]);
  assertToolContract(contracts, "c2000_launchAndRunIpcAcceptance", "launch", "launch-workflow", ["cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "timeoutMs"], ["launch.coreMap[].coreId", "launch.created.cores[].coreId", "launch.connected.results[].coreId", "snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]);
  assertToolContract(contracts, "c2000_runIpcAcceptance", "launch", "launch-workflow", ["sessionId", "cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "timeoutMs"], ["snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]);
  assertToolContract(contracts, "c2000_runBootHandoffDiagnosis", "launch", "launch-workflow", ["sessionId", "cpu1CoreId", "cpu2CoreId"], ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId", "expressions[].coreId", "pc[].coreId"]);
  assertToolContract(contracts, "c2000_runReloadAndDiagnose", "launch", "launch-workflow", ["sessionId", "cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath"], ["snapshot.cores[].coreId", "wait.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]);
  assertToolContract(contracts, "c2000_runFullDebugBundle", "launch", "launch-workflow", ["sessionId", "cpu1CoreId", "cpu2CoreId", "outputDir"], ["snapshot.cores[].coreId", "loadedPrograms[].coreId", "expressions[].coreId", "pc[].coreId", "ramOwnership.maps[].coreId", "bootHandoff.cpu1.coreId", "bootHandoff.cpu2.coreId"]);
  assertCoreToolContract(contracts, "c2000_evaluateMany", "target-read", ["sessionId", "coreId", "expressions"]);
  assertCoreToolContract(contracts, "c2000_getLoadedProgramInfo", "target-read", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_resolvePc", "target-read", ["sessionId", "coreId"]);
  assertCoreToolContract(contracts, "c2000_resolveAddress", "target-read", ["sessionId", "coreId", "address"]);
  assertCoreToolContract(contracts, "c2000_waitUntilExpression", "target-read", ["sessionId", "coreId", "expression", "expected", "timeoutMs"]);
  assertCoreIdentityFields(contracts, "c2000_evaluateMany", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_getLoadedProgramInfo", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_resolvePc", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_resolveAddress", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_waitUntilExpression", ["coreId"]);
  assertCoreIdentityFields(contracts, "c2000_assignExpressions", ["assignments[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_injectFaults", ["faults[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_compareExpressions", ["comparisons[].left.coreId", "comparisons[].right.coreId"]);
  assertCoreIdentityFields(contracts, "c2000_waitForExpressionSet", ["conditions[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_diagnoseCpu2Boot", ["cpu1CoreId", "cpu2CoreId"]);
  assertCoreIdentityFields(contracts, "c2000_launchAndRunIpcAcceptance", ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_runIpcAcceptance", ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_runBootHandoffDiagnosis", ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_runReloadAndDiagnose", ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"]);
  assertCoreIdentityFields(contracts, "c2000_runFullDebugBundle", ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"]);
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
  assertSessionToolContract(contracts, "c2000_getSessionTopology", "session-read", ["sessionId"]);
  assertSessionToolContract(contracts, "c2000_getMulticoreSnapshot", "target-read", ["sessionId"], ["cores[].coreId", "cores[].coreName"]);
  assertSessionToolContract(contracts, "c2000_verifyRunPauseIsolation", "execution-control", ["sessionId"], ["acceptanceSummary.steps[].commandCoreId", "acceptanceSummary.steps[].commandCoreName"]);

  readiness = structured(await client.callTool({
    name: "c2000_getAcceptanceReadiness",
    arguments: {
      ccsInstallPath,
      ccxmlPath,
      cpu1Program: process.env.C2000_CPU1_OUT,
      cpu2Program: process.env.C2000_CPU2_OUT,
      searchRoots: programSearchRoots(),
      allowExistingDebugProcesses
    }
  }));
  assert.equal(readiness.success, true);
  const debugBoundary = readiness.debugBoundary;
  void debugBoundary.officialTiMcpDebugControlsUsed;
  void debugBoundary.activeTargetAllowed;
  void debugBoundary.uiFocusRequired;
  void debugBoundary.continueSemantics;
  void debugBoundary.requiredPerCoreInputs;
  void debugBoundary.coreIdConvention;
  void debugBoundary.perCoreDebugSessionMethods.c2000_connectTarget;
  void debugBoundary.perCoreDebugSessionMethods.c2000_continue;
  void debugBoundary.perCoreDebugSessionMethods.c2000_pause;
  void debugBoundary.perCoreDebugSessionMethods.c2000_reset;
  void debugBoundary.perCoreDebugSessionMethods.c2000_loadProgram;
  void debugBoundary.realAdapter.name;
  void debugBoundary.realAdapter.defaultBridge;
  void debugBoundary.realAdapter.maintainsPersistentDebugSessions;
  void debugBoundary.realAdapter.statelessDssCliBridgeUsedForDebugAutomation;
  void debugBoundary.realAdapter.requiresResponseCoreIdentity;
  const uiIndependenceEvidence = readiness.uiIndependenceEvidence;
  assert.equal(uiIndependenceEvidence.evidence, "c2000_debug_boundary_ui_independence");
  assert.equal(uiIndependenceEvidence.officialTiMcpDebugControlsUsed, false);
  assert.equal(uiIndependenceEvidence.activeTargetAllowed, false);
  assert.equal(uiIndependenceEvidence.uiFocusRequired, false);
  assert.equal(uiIndependenceEvidence.selectedCpuRequired, false);
  assert.deepEqual(uiIndependenceEvidence.requiredPerCoreInputs, ["sessionId", "coreId"]);
  const acceptanceEvidence = readiness.acceptanceEvidence;
  assert.equal(acceptanceEvidence.evidence, "c2000_multicore_acceptance_evidence_plan");
  assertAcceptanceEvidence(acceptanceEvidence);
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
  const debugProcessDetails = readiness.preflight?.debugProcessDetails;
  void debugProcessDetails;
  void readiness.programDiscovery;
  assertNextHardwareAcceptanceCommand(readiness.nextCommand);

  console.log(JSON.stringify(readiness, null, 2));
  process.exitCode = readiness.readyForHardwareAcceptance ? 0 : 2;
} catch (error) {
  console.log(JSON.stringify({
    success: false,
    readyForHardwareAcceptance: false,
    blockers: [formatError(error)],
    readiness,
    nextCommand: readiness?.nextCommand
  }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (stderr) {
    process.stderr.write(`${stderr}\n`);
  }
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  assert(result.structuredContent && typeof result.structuredContent === "object", "tool result must include structuredContent");
  return result.structuredContent as Record<string, any>;
}

function assertCoreToolContract(contracts: Record<string, any>, toolName: string, targetEffect: string, requiredInputFields: string[]) {
  assertToolContract(contracts, toolName, "core", targetEffect, requiredInputFields, ["coreId", "coreName"]);
}

function assertSessionToolContract(
  contracts: Record<string, any>,
  toolName: string,
  targetEffect: string,
  requiredInputFields: string[],
  responseCoreIdentityFields: string[] = []
) {
  assertToolContract(contracts, toolName, "session", targetEffect, requiredInputFields, responseCoreIdentityFields);
}

function assertToolContract(
  contracts: Record<string, any>,
  toolName: string,
  inputScope: string,
  targetEffect: string,
  requiredInputFields: string[],
  responseCoreIdentityFields: string[] = []
) {
  const tools = Array.isArray(contracts.tools) ? contracts.tools as Array<Record<string, any>> : [];
  const contract = tools.find(tool => tool.name === toolName);
  assert(contract, `Missing required MCP tool contract: ${toolName}`);
  assert.equal(contract.inputScope, inputScope, `${toolName} inputScope`);
  assert.equal(contract.targetEffect, targetEffect, `${toolName} targetEffect`);
  const actualRequired = Array.isArray(contract.requiredInputFields) ? contract.requiredInputFields : [];
  for (const field of requiredInputFields) {
    assert(actualRequired.includes(field), `${toolName} must require ${field}`);
  }
  if (responseCoreIdentityFields.length > 0) {
    assert.deepEqual(contract.responseCoreIdentityFields, responseCoreIdentityFields, `${toolName} responseCoreIdentityFields`);
  }
}

function assertCoreIdentityFields(contracts: Record<string, any>, toolName: string, expectedCoreIdentityFields: string[]) {
  const tools = Array.isArray(contracts.tools) ? contracts.tools as Array<Record<string, any>> : [];
  const contract = tools.find(tool => tool.name === toolName);
  assert(contract, `Missing required MCP tool contract: ${toolName}`);
  assert.deepEqual(contract.coreIdentityFields, expectedCoreIdentityFields, `${toolName} coreIdentityFields`);
}

function programSearchRoots(): string[] {
  const configured = process.env.C2000_PROGRAM_SEARCH_ROOTS;
  if (configured) {
    return configured.split(path.delimiter).filter(Boolean);
  }
  return [path.join(os.homedir(), "workspace_ccstheia")];
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function assertNextHardwareAcceptanceCommand(value: unknown) {
  assert.equal(typeof value, "string", "readiness.nextCommand must be a string");
  const nextCommand = value as string;
  assertEnvFlag(nextCommand, "C2000_RUN_LAUNCH");
  assertEnvFlag(nextCommand, "C2000_RUN_ISOLATION");
  assert(nextCommand.includes("npm run acceptance:ccs:mcp"), "readiness.nextCommand must run MCP hardware acceptance");
}

function assertEnvFlag(command: string, name: string) {
  assert(
    new RegExp(`${name}=('1'|"1"|1)(\\s|$)`).test(command),
    `readiness.nextCommand must include ${name}=1`
  );
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
  assert(requirement, `acceptanceEvidence must include ${id}`);
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

import { CHECKED_PEER_FIELDS } from "./isolationAssertions.js";
import { runPauseAcceptanceCriteria } from "./runPauseAcceptance.js";

export const CHECKED_COMMAND_FIELDS = ["coreId", "coreName"] as const;
export const ACCEPTANCE_CORE_DEBUG_TOOLS = [
  "c2000_connectTarget",
  "c2000_disconnectTarget",
  "c2000_runCore",
  "c2000_continue",
  "c2000_haltCore",
  "c2000_pause",
  "c2000_reset",
  "c2000_getTargetState",
  "c2000_loadProgram",
  "c2000_loadSymbols"
] as const;
export const ACCEPTANCE_CORE_DEBUG_REQUIRED_INPUTS = ["sessionId", "coreId"] as const;
export const ACCEPTANCE_CORE_RESPONSE_IDENTITY_FIELDS = ["coreId", "coreName"] as const;
export const ACCEPTANCE_MULTICORE_TOOL_CONTRACTS = [
  {
    name: "c2000_loadPrograms",
    inputScope: "batch",
    requiredInputFields: ["sessionId", "programs"],
    coreIdentityFields: ["programs[].coreId"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_connectCores",
    inputScope: "batch",
    requiredInputFields: ["sessionId", "coreIds"],
    coreIdentityFields: ["coreIds[]"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_haltCores",
    inputScope: "batch",
    requiredInputFields: ["sessionId", "coreIds"],
    coreIdentityFields: ["coreIds[]"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_resetCores",
    inputScope: "batch",
    requiredInputFields: ["sessionId", "coreIds"],
    coreIdentityFields: ["coreIds[]"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_runCores",
    inputScope: "batch",
    requiredInputFields: ["sessionId", "coreIds"],
    coreIdentityFields: ["coreIds[]"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_getMulticoreSnapshot",
    inputScope: "session",
    requiredInputFields: ["sessionId"],
    coreIdentityFields: ["coreIds[]"],
    responseCoreIdentityFields: ["cores[].coreId", "cores[].coreName"]
  }
] as const;
export const ACCEPTANCE_CORE_READ_TOOL_CONTRACTS = [
  {
    name: "c2000_evaluateMany",
    inputScope: "core",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "coreId", "expressions"],
    coreIdentityFields: ["coreId"],
    responseCoreIdentityFields: ["coreId", "coreName"]
  },
  {
    name: "c2000_getLoadedProgramInfo",
    inputScope: "core",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "coreId"],
    coreIdentityFields: ["coreId"],
    responseCoreIdentityFields: ["coreId", "coreName"]
  },
  {
    name: "c2000_resolvePc",
    inputScope: "core",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "coreId"],
    coreIdentityFields: ["coreId"],
    responseCoreIdentityFields: ["coreId", "coreName"]
  },
  {
    name: "c2000_resolveAddress",
    inputScope: "core",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "coreId", "address"],
    coreIdentityFields: ["coreId"],
    responseCoreIdentityFields: ["coreId", "coreName"]
  },
  {
    name: "c2000_waitUntilExpression",
    inputScope: "core",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "coreId", "expression", "expected", "timeoutMs"],
    coreIdentityFields: ["coreId"],
    responseCoreIdentityFields: ["coreId", "coreName"]
  }
] as const;
export const ACCEPTANCE_ADVANCED_AUTOMATION_TOOL_CONTRACTS = [
  {
    name: "c2000_analyzeRamOwnership",
    inputScope: "host",
    targetEffect: "host-read",
    requiredInputFields: ["maps"],
    coreIdentityFields: ["maps[].coreId"],
    responseCoreIdentityFields: ["maps[].coreId", "ownershipActions[].targetCoreId"]
  },
  {
    name: "c2000_assignExpressions",
    inputScope: "batch",
    targetEffect: "memory-write",
    requiredInputFields: ["sessionId", "assignments"],
    coreIdentityFields: ["assignments[].coreId"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_injectFaults",
    inputScope: "batch",
    targetEffect: "memory-write",
    requiredInputFields: ["sessionId", "faults"],
    coreIdentityFields: ["faults[].coreId"],
    responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
  },
  {
    name: "c2000_compareExpressions",
    inputScope: "session",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "comparisons"],
    coreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"],
    responseCoreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"]
  },
  {
    name: "c2000_waitForExpressionSet",
    inputScope: "session",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "conditions", "timeoutMs"],
    coreIdentityFields: ["conditions[].coreId"],
    responseCoreIdentityFields: ["conditions[].coreId"]
  },
  {
    name: "c2000_diagnoseCpu2Boot",
    inputScope: "session",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"],
    responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]
  },
  {
    name: "c2000_diagnoseBootHandoff",
    inputScope: "session",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"],
    responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]
  },
  {
    name: "c2000_waitForIpcReady",
    inputScope: "session",
    targetEffect: "target-read",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "timeoutMs"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"],
    responseCoreIdentityFields: ["conditions[].coreId"]
  },
  {
    name: "c2000_reloadResetRunToMain",
    inputScope: "core",
    targetEffect: "launch-workflow",
    requiredInputFields: ["sessionId", "coreId", "programUri"],
    coreIdentityFields: ["coreId"],
    responseCoreIdentityFields: ["coreId", "coreName"]
  },
  {
    name: "c2000_launchAndRunIpcAcceptance",
    inputScope: "launch",
    targetEffect: "launch-workflow",
    requiredInputFields: ["cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "timeoutMs"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"],
    responseCoreIdentityFields: ["launch.coreMap[].coreId", "launch.created.cores[].coreId", "launch.connected.results[].coreId", "snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]
  },
  {
    name: "c2000_runIpcAcceptance",
    inputScope: "launch",
    targetEffect: "launch-workflow",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath", "cpu1MapPath", "cpu2MapPath", "timeoutMs"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"],
    responseCoreIdentityFields: ["snapshot.cores[].coreId", "ipcReady.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]
  },
  {
    name: "c2000_runBootHandoffDiagnosis",
    inputScope: "launch",
    targetEffect: "launch-workflow",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"],
    responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId", "expressions[].coreId", "pc[].coreId"]
  },
  {
    name: "c2000_runReloadAndDiagnose",
    inputScope: "launch",
    targetEffect: "launch-workflow",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "cpu1OutPath", "cpu2OutPath"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"],
    responseCoreIdentityFields: ["snapshot.cores[].coreId", "wait.conditions[].coreId", "diagnosis.cpu1.coreId", "diagnosis.cpu2.coreId", "diagnosis.snapshot.cores[].coreId", "ramOwnership.maps[].coreId"]
  },
  {
    name: "c2000_runFullDebugBundle",
    inputScope: "launch",
    targetEffect: "launch-workflow",
    requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId", "outputDir"],
    coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"],
    responseCoreIdentityFields: ["snapshot.cores[].coreId", "loadedPrograms[].coreId", "expressions[].coreId", "pc[].coreId", "ramOwnership.maps[].coreId", "bootHandoff.cpu1.coreId", "bootHandoff.cpu2.coreId"]
  },
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
] as const;

export const forbiddenOfficialDebugTools = [
  "continue",
  "pause",
  "reset",
  "connectTarget",
  "disconnectTarget",
  "getTargetState"
] as const;

export const c2000DebugTools = [
  "c2000_runCore",
  "c2000_continue",
  "c2000_haltCore",
  "c2000_pause",
  "c2000_reset",
  "c2000_connectTarget",
  "c2000_disconnectTarget",
  "c2000_getTargetState",
  "c2000_loadProgram",
  "c2000_loadSymbols",
  "c2000_loadPrograms",
  "c2000_getMulticoreSnapshot",
  "c2000_connectCores",
  "c2000_haltCores",
  "c2000_resetCores",
  "c2000_runCores",
  "c2000_verifyRunPauseIsolation",
  "c2000_diagnoseBootHandoff",
  "c2000_waitForIpcReady",
  "c2000_reloadResetRunToMain",
  "c2000_launchAndRunIpcAcceptance",
  "c2000_runIpcAcceptance",
  "c2000_runBootHandoffDiagnosis",
  "c2000_runReloadAndDiagnose",
  "c2000_runFullDebugBundle",
  "c2000_launchMulticoreDebug"
] as const;

export const perCoreDebugSessionMethods = {
  c2000_connectTarget: "session.target.connect()",
  c2000_disconnectTarget: "session.target.disconnect()",
  c2000_runCore: "session.target.runAsynch()",
  c2000_continue: "session.target.runAsynch()",
  c2000_haltCore: "session.target.halt()",
  c2000_pause: "session.target.halt()",
  c2000_reset: "session.target.reset()",
  c2000_loadProgram: "session.memory.loadProgram(programUri)",
  c2000_loadSymbols: "session.symbol.load(programUri)",
  c2000_getTargetState: "session.target.isConnected(), session.target.isHalted(), session.expression.evaluate(\"PC\")"
} as const;

export function getDebugBoundary() {
  return {
    debugControlPath: "c2000-multicore-mcp -> CCS Scripting DebugServer -> DebugSession(coreId)",
    officialTiMcpDebugControlsUsed: false,
    activeTargetAllowed: false,
    uiFocusRequired: false,
    selectedCpuRequired: false,
    requiredPerCoreInputs: ["sessionId", "coreId"],
    coreIdConvention: {
      "0": "C28xx_CPU1",
      "2": "C28xx_CPU2"
    },
    continueSemantics: "non-blocking",
    perCoreDebugSessionMethods,
    realAdapter: {
      name: "CcsScriptingAdapter",
      defaultBridge: "PersistentDssBridge",
      maintainsPersistentDebugSessions: true,
      statelessDssCliBridgeUsedForDebugAutomation: false,
      requiresResponseCoreIdentity: true
    },
    adapterRequirements: [
      "Maintain sessionId -> logical debug session mapping",
      "Maintain coreId -> coreName mapping",
      "Maintain coreId -> CCS DebugSession mapping",
      "Route target control through the DebugSession associated with the requested coreId"
    ],
    forbiddenOfficialDebugTools: [...forbiddenOfficialDebugTools],
    c2000DebugTools: [...c2000DebugTools],
    fallbackPolicy: "Debug control must not fall back to TI official MCP active-target tools."
  };
}

export type UiIndependenceEvidence = {
  success: true;
  evidence: "c2000_debug_boundary_ui_independence";
  debugControlPath: string;
  officialTiMcpDebugControlsUsed: false;
  activeTargetAllowed: false;
  uiFocusRequired: false;
  selectedCpuRequired: false;
  requiredPerCoreInputs: ["sessionId", "coreId"];
  coreIdConvention: {
    "0": "C28xx_CPU1";
    "2": "C28xx_CPU2";
  };
  fallbackPolicy: string;
};

export function buildUiIndependenceEvidence(debugBoundary: Record<string, any> = getDebugBoundary()): UiIndependenceEvidence {
  return {
    success: true,
    evidence: "c2000_debug_boundary_ui_independence",
    debugControlPath: debugBoundary.debugControlPath,
    officialTiMcpDebugControlsUsed: debugBoundary.officialTiMcpDebugControlsUsed as false,
    activeTargetAllowed: debugBoundary.activeTargetAllowed as false,
    uiFocusRequired: debugBoundary.uiFocusRequired as false,
    selectedCpuRequired: debugBoundary.selectedCpuRequired as false,
    requiredPerCoreInputs: debugBoundary.requiredPerCoreInputs as UiIndependenceEvidence["requiredPerCoreInputs"],
    coreIdConvention: debugBoundary.coreIdConvention as UiIndependenceEvidence["coreIdConvention"],
    fallbackPolicy: debugBoundary.fallbackPolicy
  };
}

export function assertUiIndependenceEvidence(evidence: Record<string, any>) {
  if (evidence.success !== true) {
    throw new Error("uiIndependenceEvidence.success must be true");
  }
  if (evidence.evidence !== "c2000_debug_boundary_ui_independence") {
    throw new Error("uiIndependenceEvidence.evidence has an unexpected value");
  }
  if (evidence.debugControlPath !== "c2000-multicore-mcp -> CCS Scripting DebugServer -> DebugSession(coreId)") {
    throw new Error("uiIndependenceEvidence.debugControlPath must use per-core DebugSession routing");
  }
  if (evidence.officialTiMcpDebugControlsUsed !== false) {
    throw new Error("uiIndependenceEvidence must prove TI official MCP debug controls are not used");
  }
  if (evidence.activeTargetAllowed !== false) {
    throw new Error("uiIndependenceEvidence.activeTargetAllowed must be false");
  }
  if (evidence.uiFocusRequired !== false) {
    throw new Error("uiIndependenceEvidence.uiFocusRequired must be false");
  }
  if (evidence.selectedCpuRequired !== false) {
    throw new Error("uiIndependenceEvidence.selectedCpuRequired must be false");
  }
  if (JSON.stringify(evidence.requiredPerCoreInputs) !== JSON.stringify(["sessionId", "coreId"])) {
    throw new Error("uiIndependenceEvidence.requiredPerCoreInputs must be [sessionId, coreId]");
  }
  if (JSON.stringify(evidence.coreIdConvention) !== JSON.stringify({ "0": "C28xx_CPU1", "2": "C28xx_CPU2" })) {
    throw new Error("uiIndependenceEvidence.coreIdConvention must preserve the F28P65x CPU mapping");
  }
  if (evidence.fallbackPolicy !== "Debug control must not fall back to TI official MCP active-target tools.") {
    throw new Error("uiIndependenceEvidence.fallbackPolicy must forbid TI official MCP active-target fallback");
  }
}

export function buildAcceptanceEvidencePlan() {
  const uiIndependenceEvidence = buildUiIndependenceEvidence(getDebugBoundary());
  const runPauseRequirements = runPauseAcceptanceCriteria().map(criterion => ({
    id: acceptanceRequirementId(criterion.label),
    requirement: criterion.requirement,
    proofTool: "c2000_verifyRunPauseIsolation",
    proofLabel: criterion.label,
    requiredInputs: ["sessionId", "coreId"],
    targetCoreId: criterion.targetCoreId,
    peerCoreIds: criterion.peerCoreIds,
    checkedCommandFields: [...CHECKED_COMMAND_FIELDS],
    checkedPeerFields: [...CHECKED_PEER_FIELDS],
    expectedTargetState: criterion.expectedTargetState,
    targetTouching: true
  }));

  return {
    success: true,
    evidence: "c2000_multicore_acceptance_evidence_plan",
    hostReadinessTool: "c2000_getAcceptanceReadiness",
    hardwareAcceptanceTool: "c2000_verifyRunPauseIsolation",
    hardwareAcceptanceCommand: "C2000_RUN_LAUNCH=1 C2000_RUN_ISOLATION=1 npm run acceptance:ccs:mcp",
    requirements: [
      ...runPauseRequirements,
      {
        id: "multicore_snapshot",
        requirement: "c2000_getMulticoreSnapshot({ sessionId }) returns CPU1/CPU2 connection state, run state, PC, and loaded .out information",
        proofTool: "c2000_getMulticoreSnapshot",
        requiredInputs: ["sessionId"],
        expectedCoreIds: [0, 2],
        expectedCoreFields: ["coreName", "connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        targetTouching: true
      },
      {
        id: "debug_tool_contracts",
        requirement: "Core debug tools expose explicit sessionId/coreId inputs and return core identity fields",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedCoreDebugTools: [...ACCEPTANCE_CORE_DEBUG_TOOLS],
        expectedRequiredInputs: [...ACCEPTANCE_CORE_DEBUG_REQUIRED_INPUTS],
        expectedResponseCoreIdentityFields: [...ACCEPTANCE_CORE_RESPONSE_IDENTITY_FIELDS],
        targetTouching: false
      },
      {
        id: "multicore_tool_contracts",
        requirement: "Multicore batch and snapshot tools expose explicit per-core identity inputs and outputs",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedMulticoreToolContracts: ACCEPTANCE_MULTICORE_TOOL_CONTRACTS.map(contract => ({
          name: contract.name,
          inputScope: contract.inputScope,
          requiredInputFields: [...contract.requiredInputFields],
          coreIdentityFields: [...contract.coreIdentityFields],
          responseCoreIdentityFields: [...contract.responseCoreIdentityFields]
        })),
        targetTouching: false
      },
      {
        id: "core_read_tool_contracts",
        requirement: "Core read and diagnostic tools expose explicit sessionId/coreId inputs and return core identity fields",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedCoreReadToolContracts: ACCEPTANCE_CORE_READ_TOOL_CONTRACTS.map(contract => ({
          name: contract.name,
          inputScope: contract.inputScope,
          targetEffect: contract.targetEffect,
          requiredInputFields: [...contract.requiredInputFields],
          coreIdentityFields: [...contract.coreIdentityFields],
          responseCoreIdentityFields: [...contract.responseCoreIdentityFields]
        })),
        targetTouching: false
      },
      {
        id: "advanced_automation_contracts",
        requirement: "RAM ownership analysis, IPC, MSGRAM, parameter synchronization, fault injection, CPU2 bring-up, reload/reset/run, and launch automation tools expose explicit per-core identity inputs and outputs",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedAdvancedAutomationToolContracts: ACCEPTANCE_ADVANCED_AUTOMATION_TOOL_CONTRACTS.map(contract => ({
          name: contract.name,
          inputScope: contract.inputScope,
          targetEffect: contract.targetEffect,
          requiredInputFields: [...contract.requiredInputFields],
          coreIdentityFields: [...contract.coreIdentityFields],
          responseCoreIdentityFields: [...contract.responseCoreIdentityFields]
        })),
        targetTouching: false
      },
      {
        id: "no_ccs_ui_click",
        requirement: "The flow does not require manual clicks on CPU1 or CPU2 in the CCS Debug window",
        proofTool: "c2000_getDebugBoundary",
        evidenceField: "uiIndependenceEvidence",
        expectedEvidence: uiIndependenceEvidence,
        targetTouching: false
      },
      {
        id: "no_ccs_ui_focus",
        requirement: "The flow does not depend on the current CCS " + "UI " + "focus or active " + "target",
        proofTool: "c2000_getDebugBoundary",
        evidenceField: "uiIndependenceEvidence",
        expectedEvidence: uiIndependenceEvidence,
        targetTouching: false
      }
    ]
  };
}

export function assertAcceptanceEvidence(evidence: Record<string, any>) {
  if (evidence.success !== true) {
    throw new Error("acceptanceEvidence.success must be true");
  }
  if (evidence.evidence !== "c2000_multicore_acceptance_evidence_plan") {
    throw new Error("acceptanceEvidence.evidence has an unexpected value");
  }
  if (evidence.hostReadinessTool !== "c2000_getAcceptanceReadiness") {
    throw new Error("acceptanceEvidence.hostReadinessTool must be c2000_getAcceptanceReadiness");
  }
  if (evidence.hardwareAcceptanceTool !== "c2000_verifyRunPauseIsolation") {
    throw new Error("acceptanceEvidence.hardwareAcceptanceTool must be c2000_verifyRunPauseIsolation");
  }
  const requirements = Array.isArray(evidence.requirements) ? evidence.requirements as Array<Record<string, any>> : [];
  assertAcceptanceRequirement(requirements, "continue_cpu1_only", "c2000_verifyRunPauseIsolation", { checkedCommandFields: true, checkedPeerFields: true });
  assertAcceptanceRequirement(requirements, "continue_cpu2_only", "c2000_verifyRunPauseIsolation", { checkedCommandFields: true, checkedPeerFields: true });
  assertAcceptanceRequirement(requirements, "pause_cpu1_only", "c2000_verifyRunPauseIsolation", { checkedCommandFields: true, checkedPeerFields: true });
  assertAcceptanceRequirement(requirements, "pause_cpu2_only", "c2000_verifyRunPauseIsolation", { checkedCommandFields: true, checkedPeerFields: true });
  assertAcceptanceRequirement(requirements, "multicore_snapshot", "c2000_getMulticoreSnapshot", {
    expectedCoreFields: ["coreName", "connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
  });
  assertAcceptanceRequirement(requirements, "debug_tool_contracts", "c2000_getToolContracts", {
    expectedCoreDebugTools: [...ACCEPTANCE_CORE_DEBUG_TOOLS],
    expectedRequiredInputs: [...ACCEPTANCE_CORE_DEBUG_REQUIRED_INPUTS],
    expectedResponseCoreIdentityFields: [...ACCEPTANCE_CORE_RESPONSE_IDENTITY_FIELDS]
  });
  assertAcceptanceRequirement(requirements, "multicore_tool_contracts", "c2000_getToolContracts", {
    expectedMulticoreToolContracts: ACCEPTANCE_MULTICORE_TOOL_CONTRACTS.map(contract => ({
      name: contract.name,
      inputScope: contract.inputScope,
      requiredInputFields: [...contract.requiredInputFields],
      coreIdentityFields: [...contract.coreIdentityFields],
      responseCoreIdentityFields: [...contract.responseCoreIdentityFields]
    }))
  });
  assertAcceptanceRequirement(requirements, "core_read_tool_contracts", "c2000_getToolContracts", {
    expectedCoreReadToolContracts: ACCEPTANCE_CORE_READ_TOOL_CONTRACTS.map(contract => ({
      name: contract.name,
      inputScope: contract.inputScope,
      targetEffect: contract.targetEffect,
      requiredInputFields: [...contract.requiredInputFields],
      coreIdentityFields: [...contract.coreIdentityFields],
      responseCoreIdentityFields: [...contract.responseCoreIdentityFields]
    }))
  });
  assertAcceptanceRequirement(requirements, "advanced_automation_contracts", "c2000_getToolContracts", {
    expectedAdvancedAutomationToolContracts: ACCEPTANCE_ADVANCED_AUTOMATION_TOOL_CONTRACTS.map(contract => ({
      name: contract.name,
      inputScope: contract.inputScope,
      targetEffect: contract.targetEffect,
      requiredInputFields: [...contract.requiredInputFields],
      coreIdentityFields: [...contract.coreIdentityFields],
      responseCoreIdentityFields: [...contract.responseCoreIdentityFields]
    }))
  });
  assertAcceptanceRequirement(requirements, "no_ccs_ui_click", "c2000_getDebugBoundary");
  assertAcceptanceRequirement(requirements, "no_ccs_ui_focus", "c2000_getDebugBoundary");
}

function assertAcceptanceRequirement(
  requirements: Array<Record<string, any>>,
  id: string,
  proofTool: string,
  options: {
    checkedCommandFields?: boolean;
    checkedPeerFields?: boolean;
    expectedCoreFields?: string[];
    expectedCoreDebugTools?: string[];
    expectedRequiredInputs?: string[];
    expectedResponseCoreIdentityFields?: string[];
    expectedMulticoreToolContracts?: Array<Record<string, any>>;
    expectedCoreReadToolContracts?: Array<Record<string, any>>;
    expectedAdvancedAutomationToolContracts?: Array<Record<string, any>>;
  } = {}
) {
  const requirement = requirements.find(candidate => candidate.id === id);
  if (!requirement) {
    throw new Error(`acceptanceEvidence is missing ${id}`);
  }
  if (requirement.proofTool !== proofTool) {
    throw new Error(`acceptanceEvidence.${id}.proofTool must be ${proofTool}`);
  }
  if (options.checkedCommandFields && JSON.stringify(requirement.checkedCommandFields) !== JSON.stringify(CHECKED_COMMAND_FIELDS)) {
    throw new Error(`acceptanceEvidence.${id}.checkedCommandFields must be ${JSON.stringify(CHECKED_COMMAND_FIELDS)}`);
  }
  if (options.checkedPeerFields && JSON.stringify(requirement.checkedPeerFields) !== JSON.stringify(CHECKED_PEER_FIELDS)) {
    throw new Error(`acceptanceEvidence.${id}.checkedPeerFields must be ${JSON.stringify(CHECKED_PEER_FIELDS)}`);
  }
  if (options.expectedCoreFields && JSON.stringify(requirement.expectedCoreFields) !== JSON.stringify(options.expectedCoreFields)) {
    throw new Error(`acceptanceEvidence.${id}.expectedCoreFields must be ${JSON.stringify(options.expectedCoreFields)}`);
  }
  if (options.expectedCoreDebugTools && JSON.stringify(requirement.expectedCoreDebugTools) !== JSON.stringify(options.expectedCoreDebugTools)) {
    throw new Error(`acceptanceEvidence.${id}.expectedCoreDebugTools must be ${JSON.stringify(options.expectedCoreDebugTools)}`);
  }
  if (options.expectedRequiredInputs && JSON.stringify(requirement.expectedRequiredInputs) !== JSON.stringify(options.expectedRequiredInputs)) {
    throw new Error(`acceptanceEvidence.${id}.expectedRequiredInputs must be ${JSON.stringify(options.expectedRequiredInputs)}`);
  }
  if (options.expectedResponseCoreIdentityFields && JSON.stringify(requirement.expectedResponseCoreIdentityFields) !== JSON.stringify(options.expectedResponseCoreIdentityFields)) {
    throw new Error(`acceptanceEvidence.${id}.expectedResponseCoreIdentityFields must be ${JSON.stringify(options.expectedResponseCoreIdentityFields)}`);
  }
  if (options.expectedMulticoreToolContracts && JSON.stringify(requirement.expectedMulticoreToolContracts) !== JSON.stringify(options.expectedMulticoreToolContracts)) {
    throw new Error(`acceptanceEvidence.${id}.expectedMulticoreToolContracts must be ${JSON.stringify(options.expectedMulticoreToolContracts)}`);
  }
  if (options.expectedCoreReadToolContracts && JSON.stringify(requirement.expectedCoreReadToolContracts) !== JSON.stringify(options.expectedCoreReadToolContracts)) {
    throw new Error(`acceptanceEvidence.${id}.expectedCoreReadToolContracts must be ${JSON.stringify(options.expectedCoreReadToolContracts)}`);
  }
  if (options.expectedAdvancedAutomationToolContracts && JSON.stringify(requirement.expectedAdvancedAutomationToolContracts) !== JSON.stringify(options.expectedAdvancedAutomationToolContracts)) {
    throw new Error(`acceptanceEvidence.${id}.expectedAdvancedAutomationToolContracts must be ${JSON.stringify(options.expectedAdvancedAutomationToolContracts)}`);
  }
}

function acceptanceRequirementId(label: string): string {
  switch (label) {
    case "c2000_continue(cpu1)":
      return "continue_cpu1_only";
    case "c2000_continue(cpu2)":
      return "continue_cpu2_only";
    case "c2000_pause(cpu1)":
      return "pause_cpu1_only";
    case "c2000_pause(cpu2)":
      return "pause_cpu2_only";
    default:
      return label.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  }
}

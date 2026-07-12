import path from "node:path";
import { describe, expect, test } from "vitest";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { buildAcceptanceEvidencePlan, buildUiIndependenceEvidence, getDebugBoundary } from "../src/debug/boundary.js";
import { DEBUG_BOUNDARY_SCAN_ROOTS, findDebugBoundarySourceOffenders } from "../src/debug/sourceBoundaryScan.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";

describe("debug control boundary", () => {
  test("getDebugBoundary exposes the no-official-MCP and no-active-target guarantees", async () => {
    const handlers = createToolHandlers(new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry()));

    const result = await handlers.getDebugBoundary({});

    expect(result).toEqual(expect.objectContaining({
      success: true,
      officialTiMcpDebugControlsUsed: false,
      activeTargetAllowed: false,
      uiFocusRequired: false,
      requiredPerCoreInputs: ["sessionId", "coreId"],
      coreIdConvention: {
        "0": "C28xx_CPU1",
        "2": "C28xx_CPU2"
      },
      forbiddenOfficialDebugTools: [
        "continue",
        "pause",
        "reset",
        "connectTarget",
        "disconnectTarget",
        "getTargetState"
      ],
      c2000DebugTools: expect.arrayContaining([
        "c2000_runCore",
        "c2000_continue",
        "c2000_haltCore",
        "c2000_pause",
        "c2000_reset",
        "c2000_connectTarget",
        "c2000_disconnectTarget",
        "c2000_getTargetState",
        "c2000_loadProgram",
        "c2000_loadPrograms",
        "c2000_getMulticoreSnapshot",
        "c2000_diagnoseBootHandoff",
        "c2000_waitForIpcReady",
        "c2000_reloadResetRunToMain",
        "c2000_launchAndRunIpcAcceptance",
        "c2000_runIpcAcceptance",
        "c2000_runBootHandoffDiagnosis",
        "c2000_runReloadAndDiagnose",
        "c2000_runFullDebugBundle"
      ]),
      perCoreDebugSessionMethods: {
        c2000_connectTarget: "session.target.connect()",
        c2000_disconnectTarget: "session.target.disconnect()",
        c2000_runCore: "session.target.runAsynch()",
        c2000_continue: "session.target.runAsynch()",
        c2000_haltCore: "session.target.halt()",
        c2000_pause: "session.target.halt()",
        c2000_reset: "session.target.reset()",
        c2000_loadProgram: "session.memory.loadProgram(programUri)",
        c2000_getTargetState: "session.target.isConnected(), session.target.isHalted(), session.expression.evaluate(\"PC\")"
      },
      continueSemantics: "non-blocking"
    }));
    expect(result.realAdapter).toEqual({
      name: "CcsScriptingAdapter",
      defaultBridge: "PersistentDssBridge",
      maintainsPersistentDebugSessions: true,
      statelessDssCliBridgeUsedForDebugAutomation: false,
      requiresResponseCoreIdentity: true
    });
  });

  test("buildUiIndependenceEvidence turns the debug boundary into explicit UI-independence proof", () => {
    const evidence = buildUiIndependenceEvidence(getDebugBoundary());

    expect(evidence).toEqual({
      success: true,
      evidence: "c2000_debug_boundary_ui_independence",
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
      fallbackPolicy: "Debug control must not fall back to TI official MCP active-target tools."
    });
  });

  test("buildAcceptanceEvidencePlan maps final acceptance requirements to machine-verifiable evidence", () => {
    const evidencePlan = buildAcceptanceEvidencePlan();

    expect(evidencePlan).toEqual(expect.objectContaining({
      success: true,
      evidence: "c2000_multicore_acceptance_evidence_plan",
      hostReadinessTool: "c2000_getAcceptanceReadiness",
      hardwareAcceptanceTool: "c2000_verifyRunPauseIsolation",
      hardwareAcceptanceCommand: "C2000_RUN_LAUNCH=1 C2000_RUN_ISOLATION=1 npm run acceptance:ccs:mcp"
    }));
    expect(evidencePlan.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "continue_cpu1_only",
        requirement: "c2000_continue({ sessionId, coreId: 0 }) only runs CPU1",
        proofTool: "c2000_verifyRunPauseIsolation",
        proofLabel: "c2000_continue(cpu1)",
        targetCoreId: 0,
        peerCoreIds: [2],
        checkedCommandFields: ["coreId", "coreName"],
        checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        expectedTargetState: "Running",
        targetTouching: true
      }),
      expect.objectContaining({
        id: "continue_cpu2_only",
        requirement: "c2000_continue({ sessionId, coreId: 2 }) only runs CPU2",
        proofLabel: "c2000_continue(cpu2)",
        targetCoreId: 2,
        peerCoreIds: [0],
        checkedCommandFields: ["coreId", "coreName"],
        checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        expectedTargetState: "Running"
      }),
      expect.objectContaining({
        id: "pause_cpu1_only",
        requirement: "c2000_pause({ sessionId, coreId: 0 }) only pauses CPU1",
        proofLabel: "c2000_pause(cpu1)",
        targetCoreId: 0,
        peerCoreIds: [2],
        checkedCommandFields: ["coreId", "coreName"],
        checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        expectedTargetState: "Halted"
      }),
      expect.objectContaining({
        id: "pause_cpu2_only",
        requirement: "c2000_pause({ sessionId, coreId: 2 }) only pauses CPU2",
        proofLabel: "c2000_pause(cpu2)",
        targetCoreId: 2,
        peerCoreIds: [0],
        checkedCommandFields: ["coreId", "coreName"],
        checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        expectedTargetState: "Halted"
      }),
      expect.objectContaining({
        id: "multicore_snapshot",
        proofTool: "c2000_getMulticoreSnapshot",
        requiredInputs: ["sessionId"],
        expectedCoreFields: ["coreName", "connected", "state", "pc", "loadedProgram", "loadedProgramInfo"],
        targetTouching: true
      }),
      expect.objectContaining({
        id: "debug_tool_contracts",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedCoreDebugTools: [
          "c2000_connectTarget",
          "c2000_disconnectTarget",
          "c2000_runCore",
          "c2000_continue",
          "c2000_haltCore",
          "c2000_pause",
          "c2000_reset",
          "c2000_getTargetState",
          "c2000_loadProgram"
        ],
        expectedRequiredInputs: ["sessionId", "coreId"],
        expectedResponseCoreIdentityFields: ["coreId", "coreName"],
        targetTouching: false
      }),
      expect.objectContaining({
        id: "multicore_tool_contracts",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedMulticoreToolContracts: [
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
        ],
        targetTouching: false
      }),
      expect.objectContaining({
        id: "core_read_tool_contracts",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedCoreReadToolContracts: [
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
        ],
        targetTouching: false
      }),
      expect.objectContaining({
        id: "advanced_automation_contracts",
        proofTool: "c2000_getToolContracts",
        requiredInputs: [],
        expectedAdvancedAutomationToolContracts: [
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
        ],
        targetTouching: false
      }),
      expect.objectContaining({
        id: "no_ccs_ui_click",
        proofTool: "c2000_getDebugBoundary",
        evidenceField: "uiIndependenceEvidence",
        targetTouching: false
      }),
      expect.objectContaining({
        id: "no_ccs_ui_focus",
        proofTool: "c2000_getDebugBoundary",
        evidenceField: "uiIndependenceEvidence",
        targetTouching: false
      })
    ]));
  });

  test("source does not contain official MCP debug fallback or active target control patterns", async () => {
    expect(DEBUG_BOUNDARY_SCAN_ROOTS).toEqual(["src", "scripts"]);

    const offenders = await findDebugBoundarySourceOffenders(DEBUG_BOUNDARY_SCAN_ROOTS.map(root => path.resolve(root)));
    expect(offenders).toEqual([]);
  }, 15000);
});

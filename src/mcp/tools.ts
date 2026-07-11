import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import { createToolHandlers } from "./toolHandlers.js";
import { validateToolPaths, type FilesystemPolicy } from "../security/pathPolicy.js";
import type { ResolveTiEnvironmentOptions } from "../config/tiPaths.js";
import {
  acceptanceProgramDiscoverySchema,
  acceptanceEvidenceSchema,
  acceptanceReadinessSchema,
  assignExpressionSchema,
  assignExpressionsSchema,
  batchCoresSchema,
  compareExpressionsSchema,
  createDebugSessionSchema,
  debugBoundarySchema,
  diagnoseCpu2BootSchema,
  evaluateManySchema,
  environmentSchema,
  hardwarePreflightSchema,
  injectFaultsSchema,
  launchAndRunIpcAcceptanceSchema,
  launchMulticoreDebugSchema,
  launchMulticoreDebugSafeSchema,
  launchMulticoreDebugWithActionsSchema,
  loadProgramsSchema,
  loadProgramSchema,
  multicoreSnapshotSchema,
  diagnoseBootHandoffSchema,
  ramOwnershipAnalysisSchema,
  reloadResetRunToMainSchema,
  resetCoresSchema,
  resetCoreSchema,
  resolveAddressSchema,
  runBootHandoffDiagnosisSchema,
  runFullDebugBundleSchema,
  runIpcAcceptanceSchema,
  runReloadAndDiagnoseSchema,
  sessionCoreSchema,
  sessionSchema,
  toolContractsSchema,
  verifyRunPauseIsolationSchema,
  waitForIpcReadySchema,
  waitForExpressionSetSchema,
  waitUntilExpressionSchema
} from "./toolSchemas.js";

type ZodObjectSchema = z.AnyZodObject;
type Handler = (input: any) => Promise<Record<string, unknown>>;
type ToolInputScope = "host" | "session" | "core" | "batch" | "launch";
type ToolTargetEffect =
  | "host-read"
  | "session-read"
  | "session-lifecycle"
  | "target-read"
  | "connectivity-control"
  | "execution-control"
  | "reset-control"
  | "program-load"
  | "memory-write"
  | "launch-workflow";

export type ToolEffect = "host-read" | "host-write" | "host-process-terminate" | "session-create" | "session-dispose" | "target-read" | "target-connect" | "target-disconnect" | "target-run" | "target-halt" | "target-reset" | "program-load" | "target-memory-write" | "ram-ownership-change" | "fault-injection" | "bundle-write";
export type ToolProfile = "readonly" | "safe" | "full";
type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: ZodObjectSchema;
  handlerName: keyof ReturnType<typeof createToolHandlers>;
  inputScope: ToolInputScope;
  targetEffect: ToolTargetEffect;
  coreIdentityFields?: string[];
  responseCoreIdentityFields?: string[];
  effects: ToolEffect[];
  annotations: ToolAnnotations;
  approvalClass: "read-only" | "session-lifecycle" | "target-control" | "program-load" | "target-mutation" | "workflow-confirmation";
}

const singleCoreResponseIdentity = ["coreId", "coreName"] as const;
const coreOnlyResponseIdentity = ["coreId", "coreName"] as const;
const batchCoreResponseIdentity = ["results[].coreId", "results[].coreName"] as const;
const snapshotCoreResponseIdentity = ["cores[].coreId", "cores[].coreName"] as const;
const comparisonResponseIdentity = ["comparisons[].left.coreId", "comparisons[].right.coreId"] as const;
const waitSetResponseIdentity = ["conditions[].coreId"] as const;
const diagnoseCpu2BootResponseIdentity = ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"] as const;
const ramOwnershipResponseIdentity = ["maps[].coreId", "ownershipActions[].targetCoreId"] as const;
const diagnoseBootHandoffResponseIdentity = ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId", "ramOwnership.maps[].coreId"] as const;
const workflowIpcAcceptanceResponseIdentity = [
  "snapshot.cores[].coreId",
  "ipcReady.conditions[].coreId",
  "diagnosis.cpu1.coreId",
  "diagnosis.cpu2.coreId",
  "diagnosis.snapshot.cores[].coreId",
  "ramOwnership.maps[].coreId"
] as const;
const launchAndRunIpcAcceptanceResponseIdentity = [
  "launch.coreMap[].coreId",
  "launch.created.cores[].coreId",
  "launch.connected.results[].coreId",
  ...workflowIpcAcceptanceResponseIdentity
] as const;
const workflowBootHandoffResponseIdentity = [
  "cpu1.coreId",
  "cpu2.coreId",
  "snapshot.cores[].coreId",
  "ramOwnership.maps[].coreId",
  "expressions[].coreId",
  "pc[].coreId"
] as const;
const workflowReloadAndDiagnoseResponseIdentity = [
  "snapshot.cores[].coreId",
  "wait.conditions[].coreId",
  "diagnosis.cpu1.coreId",
  "diagnosis.cpu2.coreId",
  "diagnosis.snapshot.cores[].coreId",
  "ramOwnership.maps[].coreId"
] as const;
const workflowFullBundleResponseIdentity = [
  "snapshot.cores[].coreId",
  "loadedPrograms[].coreId",
  "expressions[].coreId",
  "pc[].coreId",
  "ramOwnership.maps[].coreId",
  "bootHandoff.cpu1.coreId",
  "bootHandoff.cpu2.coreId"
] as const;
const runPauseAcceptanceResponseIdentity = [
  "acceptanceSummary.steps[].commandCoreId",
  "acceptanceSummary.steps[].commandCoreName"
] as const;
const launchResponseIdentity = [
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
] as const;

const baseToolDefinitions: Array<Omit<ToolDefinition, "effects" | "annotations" | "approvalClass">> = [
  { name: "c2000_getEnvironment", title: "Get C2000 Environment", description: "Discover and validate installed CCS, C2000Ware, and F28P65x target configuration paths without touching the target.", schema: environmentSchema, handlerName: "getEnvironment", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_getToolContracts", title: "Get C2000 Tool Contracts", description: "Return read-only tool input scope metadata so MCP clients can distinguish host, session, core, batch, and launch tools.", schema: toolContractsSchema, handlerName: "getToolContracts", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_getDebugBoundary", title: "Get C2000 Debug Boundary", description: "Return read-only guarantees that F28P65x debug control uses explicit per-core c2000 tools, not TI official MCP active-target controls.", schema: debugBoundarySchema, handlerName: "getDebugBoundary", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_getAcceptanceEvidence", title: "Get C2000 Acceptance Evidence", description: "Return a read-only map from final F28P65x acceptance requirements to the c2000 tools and evidence fields that prove them.", schema: acceptanceEvidenceSchema, handlerName: "getAcceptanceEvidence", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_getHardwarePreflight", title: "Get C2000 Hardware Preflight", description: "Run read-only host checks for XDS110 enumeration and existing CCS debug owner processes before target control.", schema: hardwarePreflightSchema, handlerName: "getHardwarePreflight", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_discoverAcceptancePrograms", title: "Discover C2000 Acceptance Programs", description: "Find CPU1 and CPU2 .out files for F28P65x hardware acceptance without touching the target.", schema: acceptanceProgramDiscoverySchema, handlerName: "discoverAcceptancePrograms", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_getAcceptanceReadiness", title: "Get C2000 Acceptance Readiness", description: "Return a read-only hardware acceptance readiness report that combines ccxml, CPU program discovery, XDS110 preflight, debug ownership, and debug boundary checks.", schema: acceptanceReadinessSchema, handlerName: "getAcceptanceReadiness", inputScope: "host", targetEffect: "host-read" },
  { name: "c2000_analyzeRamOwnership", title: "Analyze C2000 RAM Ownership", description: "Parse C2000 linker .map files and report GS RAM ownership handoff writes required before CPU2 loads.", schema: ramOwnershipAnalysisSchema, handlerName: "analyzeRamOwnership", inputScope: "host", targetEffect: "host-read", coreIdentityFields: ["maps[].coreId"], responseCoreIdentityFields: [...ramOwnershipResponseIdentity] },
  { name: "c2000_createDebugSession", title: "Create C2000 Debug Session", description: "Create a logical multicore debug session with explicit core mapping.", schema: createDebugSessionSchema, handlerName: "createDebugSession", inputScope: "launch", targetEffect: "session-lifecycle" },
  { name: "c2000_listCores", title: "List C2000 Cores", description: "List cores for a logical debug session.", schema: sessionSchema, handlerName: "listCores", inputScope: "session", targetEffect: "session-read" },
  { name: "c2000_getSessionTopology", title: "Get C2000 Session Topology", description: "Return the logical session coreId to core target mapping without touching target state.", schema: sessionSchema, handlerName: "getSessionTopology", inputScope: "session", targetEffect: "session-read" },
  { name: "c2000_closeDebugSession", title: "Close C2000 Debug Session", description: "Close a logical debug session and dispose its adapter resources.", schema: sessionSchema, handlerName: "closeDebugSession", inputScope: "session", targetEffect: "session-lifecycle" },
  { name: "c2000_connectTarget", title: "Connect C2000 Target", description: "Connect a specific core by sessionId and coreId using the c2000 adapter path.", schema: sessionCoreSchema, handlerName: "connectTarget", inputScope: "core", targetEffect: "connectivity-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_disconnectTarget", title: "Disconnect C2000 Target", description: "Disconnect a specific core by sessionId and coreId using the c2000 adapter path.", schema: sessionCoreSchema, handlerName: "disconnectTarget", inputScope: "core", targetEffect: "connectivity-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_runCore", title: "Run C2000 Core", description: "Run a specific core by sessionId and coreId.", schema: sessionCoreSchema, handlerName: "runCore", inputScope: "core", targetEffect: "execution-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_continue", title: "Continue C2000 Core", description: "Continue a specific core by sessionId and coreId.", schema: sessionCoreSchema, handlerName: "continue", inputScope: "core", targetEffect: "execution-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_haltCore", title: "Halt C2000 Core", description: "Halt a specific core by sessionId and coreId.", schema: sessionCoreSchema, handlerName: "haltCore", inputScope: "core", targetEffect: "execution-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_pause", title: "Pause C2000 Core", description: "Pause a specific core by sessionId and coreId.", schema: sessionCoreSchema, handlerName: "pause", inputScope: "core", targetEffect: "execution-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_reset", title: "Reset C2000 Core", description: "Reset a specific core by sessionId, coreId, and resetType.", schema: resetCoreSchema, handlerName: "resetCore", inputScope: "core", targetEffect: "reset-control", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_getTargetState", title: "Get C2000 Target State", description: "Read connection state, run state and PC for one explicit core.", schema: sessionCoreSchema, handlerName: "getTargetState", inputScope: "core", targetEffect: "target-read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadProgram", title: "Load C2000 Program", description: "Load a .out program to one explicit core and record file metadata.", schema: loadProgramSchema, handlerName: "loadProgram", inputScope: "core", targetEffect: "program-load", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadPrograms", title: "Load C2000 Programs", description: "Load multiple core programs and return independent per-core results.", schema: loadProgramsSchema, handlerName: "loadPrograms", inputScope: "batch", targetEffect: "program-load", coreIdentityFields: ["programs[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_connectCores", title: "Connect C2000 Cores", description: "Connect multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "connectCores", inputScope: "batch", targetEffect: "connectivity-control", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_haltCores", title: "Halt C2000 Cores", description: "Halt multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "haltCores", inputScope: "batch", targetEffect: "execution-control", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_resetCores", title: "Reset C2000 Cores", description: "Reset multiple cores by explicit coreIds.", schema: resetCoresSchema, handlerName: "resetCores", inputScope: "batch", targetEffect: "reset-control", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_runCores", title: "Run C2000 Cores", description: "Run multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "runCores", inputScope: "batch", targetEffect: "execution-control", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_getMulticoreSnapshot", title: "Get C2000 Multicore Snapshot", description: "Read state, PC and loaded program for explicit coreIds, defaulting to every core in a session.", schema: multicoreSnapshotSchema, handlerName: "getMulticoreSnapshot", inputScope: "session", targetEffect: "target-read", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...snapshotCoreResponseIdentity] },
  { name: "c2000_evaluateMany", title: "Evaluate C2000 Expressions", description: "Evaluate multiple expressions on one explicit core with independent results.", schema: evaluateManySchema, handlerName: "evaluateMany", inputScope: "core", targetEffect: "target-read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_assignExpression", title: "Assign C2000 Expression", description: "Assign a value expression on one explicit core for fault injection or parameter synchronization checks.", schema: assignExpressionSchema, handlerName: "assignExpression", inputScope: "core", targetEffect: "memory-write", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_assignExpressions", title: "Assign C2000 Expressions", description: "Assign multiple explicit per-core expressions for fault injection, MSGRAM, IPC, or parameter synchronization setup.", schema: assignExpressionsSchema, handlerName: "assignExpressions", inputScope: "batch", targetEffect: "memory-write", coreIdentityFields: ["assignments[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_injectFaults", title: "Inject C2000 Faults", description: "Inject labeled fault values through explicit per-core expressions and optional readback verification.", schema: injectFaultsSchema, handlerName: "injectFaults", inputScope: "batch", targetEffect: "memory-write", coreIdentityFields: ["faults[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_compareExpressions", title: "Compare C2000 Expressions", description: "Compare explicit per-core expression pairs for IPC, MSGRAM and parameter synchronization checks.", schema: compareExpressionsSchema, handlerName: "compareExpressions", inputScope: "session", targetEffect: "target-read", coreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"], responseCoreIdentityFields: [...comparisonResponseIdentity] },
  { name: "c2000_getLoadedProgramInfo", title: "Get C2000 Loaded Program Info", description: "Return trusted metadata for programs loaded through this MCP.", schema: sessionCoreSchema, handlerName: "getLoadedProgramInfo", inputScope: "core", targetEffect: "target-read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_resolvePc", title: "Resolve C2000 PC", description: "Resolve current PC for one core, returning partial data when source mapping is unavailable.", schema: sessionCoreSchema, handlerName: "resolvePc", inputScope: "core", targetEffect: "target-read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_resolveAddress", title: "Resolve C2000 Address", description: "Resolve a code address for one explicit core.", schema: resolveAddressSchema, handlerName: "resolveAddress", inputScope: "core", targetEffect: "target-read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_waitUntilExpression", title: "Wait Until C2000 Expression", description: "Poll one expression until it matches the expected value or times out.", schema: waitUntilExpressionSchema, handlerName: "waitUntilExpression", inputScope: "core", targetEffect: "target-read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_waitForExpressionSet", title: "Wait For C2000 Expression Set", description: "Poll explicit per-core expressions until all conditions match or the timeout expires.", schema: waitForExpressionSetSchema, handlerName: "waitForExpressionSet", inputScope: "session", targetEffect: "target-read", coreIdentityFields: ["conditions[].coreId"], responseCoreIdentityFields: [...waitSetResponseIdentity] },
  { name: "c2000_diagnoseCpu2Boot", title: "Diagnose C2000 CPU2 Boot", description: "Collect CPU1/CPU2 snapshot, PC and boot/IPC expressions for F28P65x CPU2 bring-up debugging.", schema: diagnoseCpu2BootSchema, handlerName: "diagnoseCpu2Boot", inputScope: "session", targetEffect: "target-read", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...diagnoseCpu2BootResponseIdentity] },
  { name: "c2000_diagnoseBootHandoff", title: "Diagnose C2000 Boot Handoff", description: "Collect CPU1/CPU2 boot diagnostics plus RAM ownership map evidence and a compact handoff verdict.", schema: diagnoseBootHandoffSchema, handlerName: "diagnoseBootHandoff", inputScope: "session", targetEffect: "target-read", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...diagnoseBootHandoffResponseIdentity] },
  { name: "c2000_waitForIpcReady", title: "Wait For C2000 IPC Ready", description: "Poll default or supplied CPU1/CPU2 IPC-ready expressions until all match or timeout.", schema: waitForIpcReadySchema, handlerName: "waitForIpcReady", inputScope: "session", targetEffect: "target-read", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"], responseCoreIdentityFields: [...waitSetResponseIdentity] },
  { name: "c2000_reloadResetRunToMain", title: "Reload Reset Run C2000 Core", description: "Reload one explicit core, reset it, run it, and report that true breakpoint run-to-main is not supported by the current adapter.", schema: reloadResetRunToMainSchema, handlerName: "reloadResetRunToMain", inputScope: "core", targetEffect: "launch-workflow", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_launchAndRunIpcAcceptance", title: "Launch And Run C2000 IPC Acceptance", description: "Create and connect an explicit CPU1/CPU2 session, then run the full IPC acceptance workflow inside the MCP server with one client approval.", schema: launchAndRunIpcAcceptanceSchema, handlerName: "launchAndRunIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...launchAndRunIpcAcceptanceResponseIdentity] },
  { name: "c2000_runIpcAcceptance", title: "Run C2000 IPC Acceptance Workflow", description: "Run the full F28P65x CPU1/CPU2 IPC acceptance workflow inside the MCP server with one client approval.", schema: runIpcAcceptanceSchema, handlerName: "runIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...workflowIpcAcceptanceResponseIdentity] },
  { name: "c2000_runBootHandoffDiagnosis", title: "Run C2000 Boot Handoff Diagnosis Workflow", description: "Collect snapshot, loaded program, expressions, PC, RAM ownership, ELF freshness, and CPU2 boot diagnosis in one server-side workflow.", schema: runBootHandoffDiagnosisSchema, handlerName: "runBootHandoffDiagnosis", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"], responseCoreIdentityFields: [...workflowBootHandoffResponseIdentity] },
  { name: "c2000_runReloadAndDiagnose", title: "Run C2000 Reload And Diagnose Workflow", description: "Reload, reset, optionally run/wait, then diagnose the F28P65x CPU1/CPU2 boot handoff in one server-side workflow.", schema: runReloadAndDiagnoseSchema, handlerName: "runReloadAndDiagnose", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"], responseCoreIdentityFields: [...workflowReloadAndDiagnoseResponseIdentity] },
  { name: "c2000_runFullDebugBundle", title: "Run C2000 Full Debug Bundle Workflow", description: "Collect a full F28P65x multicore debug bundle and write summary/evidence files in one server-side workflow.", schema: runFullDebugBundleSchema, handlerName: "runFullDebugBundle", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"], responseCoreIdentityFields: [...workflowFullBundleResponseIdentity] },
  { name: "c2000_verifyRunPauseIsolation", title: "Verify C2000 Run/Pause Isolation", description: "Run and pause CPU1/CPU2 one at a time, proving each command affects only the requested core.", schema: verifyRunPauseIsolationSchema, handlerName: "verifyRunPauseIsolation", inputScope: "session", targetEffect: "execution-control", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...runPauseAcceptanceResponseIdentity] },
  { name: "c2000_launchMulticoreDebug", title: "Launch C2000 Multicore Debug", description: "Create, connect, load and snapshot a multicore debug flow.", schema: launchMulticoreDebugSchema, handlerName: "launchMulticoreDebug", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: [
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
  ], responseCoreIdentityFields: [...launchResponseIdentity] },
  { name: "c2000_launchMulticoreDebugSafe", title: "Launch C2000 Multicore Debug Safely", description: "Create, connect, load, halt, snapshot and perform read-only checks without expression writes, fault injection, reset or automatic run.", schema: launchMulticoreDebugSafeSchema, handlerName: "launchMulticoreDebugSafe", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cores[].coreId"], responseCoreIdentityFields: [...launchResponseIdentity] },
  { name: "c2000_launchMulticoreDebugWithActions", title: "Launch C2000 Multicore Debug With Target Actions", description: "Create and launch a multicore session with explicit target mutations including assignments, fault injection, or run/pause isolation.", schema: launchMulticoreDebugWithActionsSchema, handlerName: "launchMulticoreDebugWithActions", inputScope: "launch", targetEffect: "launch-workflow", coreIdentityFields: ["cores[].coreId"], responseCoreIdentityFields: [...launchResponseIdentity] }
];

export const c2000ToolDefinitions: ToolDefinition[] = baseToolDefinitions.map(definition => decorateDefinition(definition));

export function registerC2000Tools(server: McpServer, manager: DebugSessionManager, profile: ToolProfile = toolProfileFromEnv(), filesystem: FilesystemPolicy = { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] }, tiEnvironment: ResolveTiEnvironmentOptions = {}) {
  const registered = definitionsForProfile(profile);
  const handlers = createToolHandlers(manager, {
    getToolContracts: () => getToolContracts(profile),
    getToolProfile: () => ({ activeToolProfile: profile, hiddenTools: c2000ToolDefinitions.filter(tool => !registered.includes(tool)).map(tool => tool.name), profileReason: `C2000_MCP_TOOL_PROFILE=${profile}` }),
    tiEnvironment
  });

  for (const definition of registered) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.schema.shape,
        annotations: definition.annotations
      },
      async (input: any) => {
        await validateToolPaths(input, filesystem);
        const result = await (handlers[definition.handlerName] as Handler)(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: result.success === false
        };
      }
    );
  }
}

export function getToolContracts(profile: ToolProfile = "full") {
  return definitionsForProfile(profile).map(definition => {
    const inputFields = Object.keys(definition.schema.shape);
    return {
      name: definition.name,
      title: definition.title,
      inputScope: definition.inputScope,
      targetEffect: definition.targetEffect,
      effects: definition.effects,
      annotations: definition.annotations,
      approvalClass: definition.approvalClass,
      touchesTarget: definition.effects.some(effect => effect.startsWith("target-") || effect === "program-load" || effect === "ram-ownership-change"),
      writesTarget: definition.effects.some(effect => ["target-memory-write", "program-load", "ram-ownership-change"].includes(effect)),
      runsTarget: definition.effects.includes("target-run"),
      resetsTarget: definition.effects.includes("target-reset"),
      writesHostFiles: definition.effects.some(effect => effect === "host-write" || effect === "bundle-write"),
      changesRamOwnership: definition.effects.includes("ram-ownership-change"),
      inputFields,
      requiredInputFields: requiredInputFields(definition.schema),
      coreIdentityFields: definition.coreIdentityFields ?? [],
      responseCoreIdentityFields: definition.responseCoreIdentityFields ?? [],
      handlerName: definition.handlerName
    };
  });
}

export function definitionsForProfile(profile: ToolProfile): ToolDefinition[] {
  return c2000ToolDefinitions.filter(tool => profile === "full" || (profile === "readonly" ? tool.annotations.readOnlyHint : !tool.effects.includes("fault-injection") && !tool.effects.includes("target-memory-write")));
}

export function toolProfileFromEnv(): ToolProfile {
  const value = process.env.C2000_MCP_TOOL_PROFILE ?? "safe";
  return value === "readonly" || value === "full" ? value : "safe";
}

function decorateDefinition(definition: Omit<ToolDefinition, "effects" | "annotations" | "approvalClass">): ToolDefinition {
  const effects = effectsFor(definition.name, definition.targetEffect);
  const readOnlyHint = effects.every(effect => ["host-read", "target-read"].includes(effect));
  const destructiveHint = effects.some(effect => ["host-process-terminate", "target-reset", "target-memory-write", "ram-ownership-change", "fault-injection"].includes(effect));
  return {
    ...definition,
    effects,
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: false },
    approvalClass: readOnlyHint ? "read-only" : definition.targetEffect === "session-lifecycle" ? "session-lifecycle" : effects.includes("program-load") ? "program-load" : destructiveHint ? "target-mutation" : definition.targetEffect === "launch-workflow" ? "workflow-confirmation" : "target-control"
  };
}

function effectsFor(name: string, targetEffect: ToolTargetEffect): ToolEffect[] {
  if (targetEffect === "host-read" || targetEffect === "session-read") return ["host-read"];
  if (name === "c2000_createDebugSession") return ["session-create", "host-process-terminate"];
  if (name === "c2000_closeDebugSession") return ["session-dispose"];
  if (targetEffect === "target-read") return ["target-read"];
  if (targetEffect === "connectivity-control") return [name.includes("disconnect") ? "target-disconnect" : "target-connect"];
  if (targetEffect === "reset-control") return ["target-reset"];
  if (targetEffect === "program-load") return ["program-load", "ram-ownership-change"];
  if (targetEffect === "memory-write") return name.includes("injectFault") ? ["target-memory-write", "fault-injection"] : ["target-memory-write"];
  if (targetEffect === "execution-control") return [name.includes("halt") || name.includes("pause") ? "target-halt" : "target-run"];
  if (name === "c2000_runBootHandoffDiagnosis") return ["target-read"];
  if (name === "c2000_runFullDebugBundle") return ["target-read", "bundle-write"];
  if (name === "c2000_launchAndRunIpcAcceptance") return ["session-create", "host-process-terminate", "target-connect", "target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"];
  if (name === "c2000_launchMulticoreDebugSafe") return ["session-create", "host-process-terminate", "target-connect", "program-load", "ram-ownership-change", "target-halt", "target-read"];
  if (name === "c2000_launchMulticoreDebug" || name === "c2000_launchMulticoreDebugWithActions") return ["session-create", "host-process-terminate", "target-connect", "program-load", "ram-ownership-change", "target-halt", "target-read", "target-memory-write", "fault-injection", "target-run"];
  return ["target-halt", "target-reset", "program-load", "ram-ownership-change", "target-run", "target-read"];
}

function requiredInputFields(schema: ZodObjectSchema): string[] {
  const parsed = schema.safeParse({});
  if (parsed.success) {
    return [];
  }
  return Array.from(new Set(parsed.error.issues
    .filter(issue => issue.path.length === 1)
    .map(issue => String(issue.path[0]))));
}

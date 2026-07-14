import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import { createToolHandlers } from "./toolHandlers.js";
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
  hardwarePreflightSchema,
  injectFaultsSchema,
  launchAndRunIpcAcceptanceSchema,
  launchMulticoreDebugSchema,
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

type ToolRole = "primary" | "alias" | "workflow" | "host" | "diagnostic";
type ToolFamily =
  | "host"
  | "session"
  | "connectivity"
  | "execution"
  | "reset"
  | "program"
  | "read"
  | "write"
  | "wait"
  | "diagnosis"
  | "workflow";

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: ZodObjectSchema;
  handlerName: keyof ReturnType<typeof createToolHandlers>;
  inputScope: ToolInputScope;
  targetEffect: ToolTargetEffect;
  role: ToolRole;
  family: ToolFamily;
  /** When role is alias, the preferred primary tool name. */
  aliasOf?: string;
  coreIdentityFields?: string[];
  responseCoreIdentityFields?: string[];
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

export const c2000ToolDefinitions: ToolDefinition[] = [
  { name: "c2000_getToolContracts", title: "Get C2000 Tool Contracts", description: "Return tool taxonomy: families, preferred atomic tools vs aliases, and input scope metadata.", schema: toolContractsSchema, handlerName: "getToolContracts", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getDebugBoundary", title: "Get C2000 Debug Boundary", description: "Return read-only guarantees that F28P65x debug control uses explicit per-core c2000 tools, not TI official MCP active-target controls.", schema: debugBoundarySchema, handlerName: "getDebugBoundary", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getAcceptanceEvidence", title: "Get C2000 Acceptance Evidence", description: "Return a read-only map from final F28P65x acceptance requirements to the c2000 tools and evidence fields that prove them.", schema: acceptanceEvidenceSchema, handlerName: "getAcceptanceEvidence", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getHardwarePreflight", title: "Get C2000 Hardware Preflight", description: "Run read-only host checks for XDS110 enumeration and existing CCS debug owner processes before target control.", schema: hardwarePreflightSchema, handlerName: "getHardwarePreflight", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_discoverAcceptancePrograms", title: "Discover C2000 Acceptance Programs", description: "Find CPU1 and CPU2 .out files for F28P65x hardware acceptance without touching the target.", schema: acceptanceProgramDiscoverySchema, handlerName: "discoverAcceptancePrograms", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getAcceptanceReadiness", title: "Get C2000 Acceptance Readiness", description: "Return a read-only hardware acceptance readiness report that combines ccxml, CPU program discovery, XDS110 preflight, debug ownership, and debug boundary checks.", schema: acceptanceReadinessSchema, handlerName: "getAcceptanceReadiness", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_analyzeRamOwnership", title: "Analyze C2000 RAM Ownership", description: "Parse C2000 linker .map files and report GS RAM ownership handoff writes required before CPU2 loads.", schema: ramOwnershipAnalysisSchema, handlerName: "analyzeRamOwnership", inputScope: "host", targetEffect: "host-read", role: "diagnostic", family: "diagnosis", coreIdentityFields: ["maps[].coreId"], responseCoreIdentityFields: [...ramOwnershipResponseIdentity] },
  { name: "c2000_createDebugSession", title: "Create C2000 Debug Session", description: "Create a logical multicore debug session with explicit core mapping.", schema: createDebugSessionSchema, handlerName: "createDebugSession", inputScope: "launch", targetEffect: "session-lifecycle", role: "primary", family: "session" },
  { name: "c2000_listCores", title: "List C2000 Cores", description: "List cores for a logical debug session (refreshes connection state via getState).", schema: sessionSchema, handlerName: "listCores", inputScope: "session", targetEffect: "session-read", role: "primary", family: "session" },
  { name: "c2000_getSessionTopology", title: "Get C2000 Session Topology", description: "Return the logical session coreId to core target mapping without touching target state.", schema: sessionSchema, handlerName: "getSessionTopology", inputScope: "session", targetEffect: "session-read", role: "primary", family: "session" },
  { name: "c2000_closeDebugSession", title: "Close C2000 Debug Session", description: "Close a logical debug session and dispose its adapter resources.", schema: sessionSchema, handlerName: "closeDebugSession", inputScope: "session", targetEffect: "session-lifecycle", role: "primary", family: "session" },
  { name: "c2000_connectTarget", title: "Connect C2000 Target", description: "Connect a specific core by sessionId and coreId using the c2000 adapter path.", schema: sessionCoreSchema, handlerName: "connectTarget", inputScope: "core", targetEffect: "connectivity-control", role: "primary", family: "connectivity", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_disconnectTarget", title: "Disconnect C2000 Target", description: "Disconnect a specific core by sessionId and coreId using the c2000 adapter path.", schema: sessionCoreSchema, handlerName: "disconnectTarget", inputScope: "core", targetEffect: "connectivity-control", role: "primary", family: "connectivity", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_runCore", title: "Run C2000 Core", description: "Primary run control: run a specific core by sessionId and coreId. Prefer this over c2000_continue for new clients.", schema: sessionCoreSchema, handlerName: "runCore", inputScope: "core", targetEffect: "execution-control", role: "primary", family: "execution", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_continue", title: "Continue C2000 Core", description: "Alias of c2000_runCore (same handler path). Kept for TI MCP naming familiarity; prefer c2000_runCore.", schema: sessionCoreSchema, handlerName: "continue", inputScope: "core", targetEffect: "execution-control", role: "alias", family: "execution", aliasOf: "c2000_runCore", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_haltCore", title: "Halt C2000 Core", description: "Primary halt control: halt a specific core by sessionId and coreId. Prefer this over c2000_pause for new clients.", schema: sessionCoreSchema, handlerName: "haltCore", inputScope: "core", targetEffect: "execution-control", role: "primary", family: "execution", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_pause", title: "Pause C2000 Core", description: "Alias of c2000_haltCore (same handler path). Kept for TI MCP naming familiarity; prefer c2000_haltCore.", schema: sessionCoreSchema, handlerName: "pause", inputScope: "core", targetEffect: "execution-control", role: "alias", family: "execution", aliasOf: "c2000_haltCore", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_reset", title: "Reset C2000 Core", description: "Reset a specific core by sessionId, coreId, and resetType.", schema: resetCoreSchema, handlerName: "resetCore", inputScope: "core", targetEffect: "reset-control", role: "primary", family: "reset", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_getTargetState", title: "Get C2000 Target State", description: "Read connection state, run state and PC for one explicit core.", schema: sessionCoreSchema, handlerName: "getTargetState", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadProgram", title: "Load C2000 Program", description: "Load a .out program to one explicit core and record file metadata.", schema: loadProgramSchema, handlerName: "loadProgram", inputScope: "core", targetEffect: "program-load", role: "primary", family: "program", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadPrograms", title: "Load C2000 Programs", description: "Load multiple core programs and return independent per-core results.", schema: loadProgramsSchema, handlerName: "loadPrograms", inputScope: "batch", targetEffect: "program-load", role: "primary", family: "program", coreIdentityFields: ["programs[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_connectCores", title: "Connect C2000 Cores", description: "Connect multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "connectCores", inputScope: "batch", targetEffect: "connectivity-control", role: "primary", family: "connectivity", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_haltCores", title: "Halt C2000 Cores", description: "Halt multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "haltCores", inputScope: "batch", targetEffect: "execution-control", role: "primary", family: "execution", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_resetCores", title: "Reset C2000 Cores", description: "Reset multiple cores by explicit coreIds.", schema: resetCoresSchema, handlerName: "resetCores", inputScope: "batch", targetEffect: "reset-control", role: "primary", family: "reset", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_runCores", title: "Run C2000 Cores", description: "Run multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "runCores", inputScope: "batch", targetEffect: "execution-control", role: "primary", family: "execution", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_getMulticoreSnapshot", title: "Get C2000 Multicore Snapshot", description: "Read state, PC and loaded program for explicit coreIds, defaulting to every core in a session.", schema: multicoreSnapshotSchema, handlerName: "getMulticoreSnapshot", inputScope: "session", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...snapshotCoreResponseIdentity] },
  { name: "c2000_evaluateMany", title: "Evaluate C2000 Expressions", description: "Evaluate multiple expressions on one explicit core with independent results.", schema: evaluateManySchema, handlerName: "evaluateMany", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_assignExpression", title: "Assign C2000 Expression", description: "Assign a value expression on one explicit core for fault injection or parameter synchronization checks.", schema: assignExpressionSchema, handlerName: "assignExpression", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_assignExpressions", title: "Assign C2000 Expressions", description: "Assign multiple explicit per-core expressions for fault injection, MSGRAM, IPC, or parameter synchronization setup.", schema: assignExpressionsSchema, handlerName: "assignExpressions", inputScope: "batch", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["assignments[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_injectFaults", title: "Inject C2000 Faults", description: "Inject labeled fault values through explicit per-core expressions and optional readback verification.", schema: injectFaultsSchema, handlerName: "injectFaults", inputScope: "batch", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["faults[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_compareExpressions", title: "Compare C2000 Expressions", description: "Compare explicit per-core expression pairs for IPC, MSGRAM and parameter synchronization checks.", schema: compareExpressionsSchema, handlerName: "compareExpressions", inputScope: "session", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"], responseCoreIdentityFields: [...comparisonResponseIdentity] },
  { name: "c2000_getLoadedProgramInfo", title: "Get C2000 Loaded Program Info", description: "Return trusted metadata for programs loaded through this MCP.", schema: sessionCoreSchema, handlerName: "getLoadedProgramInfo", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_resolvePc", title: "Resolve C2000 PC", description: "Resolve current PC for one core, returning partial data when source mapping is unavailable.", schema: sessionCoreSchema, handlerName: "resolvePc", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_resolveAddress", title: "Resolve C2000 Address", description: "Resolve a code address for one explicit core (honest partial when symbol map unavailable).", schema: resolveAddressSchema, handlerName: "resolveAddress", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_waitUntilExpression", title: "Wait Until C2000 Expression", description: "Poll one expression until it matches the expected value or times out.", schema: waitUntilExpressionSchema, handlerName: "waitUntilExpression", inputScope: "core", targetEffect: "target-read", role: "primary", family: "wait", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_waitForExpressionSet", title: "Wait For C2000 Expression Set", description: "Poll explicit per-core expressions until all conditions match or the timeout expires.", schema: waitForExpressionSetSchema, handlerName: "waitForExpressionSet", inputScope: "session", targetEffect: "target-read", role: "primary", family: "wait", coreIdentityFields: ["conditions[].coreId"], responseCoreIdentityFields: [...waitSetResponseIdentity] },
  { name: "c2000_diagnoseCpu2Boot", title: "Diagnose C2000 CPU2 Boot", description: "Collect CPU1/CPU2 snapshot, PC and boot/IPC expressions for F28P65x CPU2 bring-up debugging. Prefer c2000_runBootHandoffDiagnosis for full handoff workflow.", schema: diagnoseCpu2BootSchema, handlerName: "diagnoseCpu2Boot", inputScope: "session", targetEffect: "target-read", role: "diagnostic", family: "diagnosis", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...diagnoseCpu2BootResponseIdentity] },
  { name: "c2000_diagnoseBootHandoff", title: "Diagnose C2000 Boot Handoff", description: "Collect CPU1/CPU2 boot diagnostics plus RAM ownership map evidence and a compact handoff verdict. Prefer workflow c2000_runBootHandoffDiagnosis when available.", schema: diagnoseBootHandoffSchema, handlerName: "diagnoseBootHandoff", inputScope: "session", targetEffect: "target-read", role: "diagnostic", family: "diagnosis", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...diagnoseBootHandoffResponseIdentity] },
  { name: "c2000_waitForIpcReady", title: "Wait For C2000 IPC Ready", description: "Poll default or supplied CPU1/CPU2 IPC-ready expressions until all match or timeout.", schema: waitForIpcReadySchema, handlerName: "waitForIpcReady", inputScope: "session", targetEffect: "target-read", role: "primary", family: "wait", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "conditions[].coreId"], responseCoreIdentityFields: [...waitSetResponseIdentity] },
  { name: "c2000_reloadResetRunToMain", title: "Reload Reset Run C2000 Core", description: "Reload one explicit core, reset it, run it, and report that true breakpoint run-to-main is not supported by the current adapter.", schema: reloadResetRunToMainSchema, handlerName: "reloadResetRunToMain", inputScope: "core", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_launchAndRunIpcAcceptance", title: "Launch And Run C2000 IPC Acceptance", description: "Preferred one-shot: create and connect CPU1/CPU2, then run full IPC acceptance inside the MCP server.", schema: launchAndRunIpcAcceptanceSchema, handlerName: "launchAndRunIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...launchAndRunIpcAcceptanceResponseIdentity] },
  { name: "c2000_runIpcAcceptance", title: "Run C2000 IPC Acceptance Workflow", description: "Preferred when session already exists: full F28P65x CPU1/CPU2 IPC acceptance in one server-side call.", schema: runIpcAcceptanceSchema, handlerName: "runIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...workflowIpcAcceptanceResponseIdentity] },
  { name: "c2000_runBootHandoffDiagnosis", title: "Run C2000 Boot Handoff Diagnosis Workflow", description: "Preferred boot diagnosis: snapshot, programs, expressions, PC, RAM ownership, ELF freshness, and CPU2 handoff in one workflow.", schema: runBootHandoffDiagnosisSchema, handlerName: "runBootHandoffDiagnosis", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"], responseCoreIdentityFields: [...workflowBootHandoffResponseIdentity] },
  { name: "c2000_runReloadAndDiagnose", title: "Run C2000 Reload And Diagnose Workflow", description: "Preferred reload path: halt/reset/load/run/wait then boot handoff diagnosis in one workflow.", schema: runReloadAndDiagnoseSchema, handlerName: "runReloadAndDiagnose", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"], responseCoreIdentityFields: [...workflowReloadAndDiagnoseResponseIdentity] },
  { name: "c2000_runFullDebugBundle", title: "Run C2000 Full Debug Bundle Workflow", description: "Preferred evidence capture: full multicore debug bundle with summary files in one workflow.", schema: runFullDebugBundleSchema, handlerName: "runFullDebugBundle", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"], responseCoreIdentityFields: [...workflowFullBundleResponseIdentity] },
  { name: "c2000_verifyRunPauseIsolation", title: "Verify C2000 Run/Pause Isolation", description: "Run and pause CPU1/CPU2 one at a time, proving each command affects only the requested core.", schema: verifyRunPauseIsolationSchema, handlerName: "verifyRunPauseIsolation", inputScope: "session", targetEffect: "execution-control", role: "diagnostic", family: "execution", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...runPauseAcceptanceResponseIdentity] },
  { name: "c2000_launchMulticoreDebug", title: "Launch C2000 Multicore Debug", description: "Create, connect, load and snapshot a multicore debug flow. Prefer workflow tools for IPC/boot diagnosis after launch.", schema: launchMulticoreDebugSchema, handlerName: "launchMulticoreDebug", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: [
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
  ], responseCoreIdentityFields: [...launchResponseIdentity] }
];

export function registerC2000Tools(server: McpServer, manager: DebugSessionManager) {
  const handlers = createToolHandlers(manager, { getToolContracts, getToolSurfaceGuide });

  for (const definition of c2000ToolDefinitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.schema.shape
      },
      async (input: any) => {
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

export function getToolContracts() {
  return c2000ToolDefinitions.map(definition => {
    const inputFields = Object.keys(definition.schema.shape);
    return {
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputScope: definition.inputScope,
      targetEffect: definition.targetEffect,
      role: definition.role,
      family: definition.family,
      aliasOf: definition.aliasOf,
      preferred: definition.role !== "alias",
      inputFields,
      requiredInputFields: requiredInputFields(definition.schema),
      coreIdentityFields: definition.coreIdentityFields ?? [],
      responseCoreIdentityFields: definition.responseCoreIdentityFields ?? [],
      handlerName: definition.handlerName
    };
  });
}

/** Compact tool-surface guide for agents: prefer workflows, then primary atomics, avoid aliases when possible. */
export function getToolSurfaceGuide() {
  const tools = getToolContracts();
  const families = Array.from(new Set(tools.map(tool => tool.family))).sort();
  const aliases = tools
    .filter(tool => tool.role === "alias")
    .map(tool => ({ name: tool.name, useInstead: tool.aliasOf }));
  const preferredWorkflows = tools.filter(tool => tool.role === "workflow").map(tool => tool.name);
  const preferredAtomics = tools
    .filter(tool => tool.role === "primary")
    .map(tool => tool.name);
  return {
    guidance: [
      "Prefer one workflow tool (c2000_launchAndRunIpcAcceptance, c2000_runIpcAcceptance, c2000_runBootHandoffDiagnosis, c2000_runReloadAndDiagnose, c2000_runFullDebugBundle) over long atomic chains.",
      "For single-step control prefer primary tools: c2000_runCore / c2000_haltCore (not c2000_continue / c2000_pause aliases).",
      "c2000_continue and c2000_pause remain registered for TI MCP naming familiarity and acceptance scripts; they are aliases, not separate semantics.",
      "Use host tools (readiness/preflight/boundary) before target-touching acceptance."
    ],
    families,
    preferredWorkflows,
    preferredAtomics,
    aliases,
    counts: {
      total: tools.length,
      primary: tools.filter(tool => tool.role === "primary").length,
      alias: aliases.length,
      workflow: preferredWorkflows.length,
      host: tools.filter(tool => tool.role === "host").length,
      diagnostic: tools.filter(tool => tool.role === "diagnostic").length
    }
  };
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

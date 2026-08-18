import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { createToolHandlers, type ToolHandlerDeps } from "./toolHandlers.js";
import { validateToolPaths, type FilesystemPolicy } from "../security/pathPolicy.js";
import type { ResolveTiEnvironmentOptions } from "../config/tiPaths.js";
import {
  exportVariableStreamSchema,
  getVariableStreamStatusSchema,
  readVariableSamplesSchema,
  startVariableStreamSchema,
  stopVariableStreamSchema
} from "../observability/VariableStreamSchemas.js";
import { dlogBufferRequestSchema } from "../observability/DlogSchemas.js";
import {
  configureEradProfileSchema,
  exportEradProfileSchema,
  getEradCapabilitiesSchema,
  readEradProfileSchema,
  startEradProfileSchema,
  stopEradProfileSchema
} from "../observability/EradSchemas.js";
import { collectFailureBundleSchema, exportTraceSchema } from "../observability/TraceSchemas.js";
import { compareRunWithBaselineSchema, createRunBaselineSchema } from "../analytics/MetricSchemas.js";
import {
  acceptanceProgramDiscoverySchema,
  acceptanceEvidenceSchema,
  acceptanceReadinessSchema,
  assignExpressionSchema,
  assignExpressionsSchema,
  batchCoresSchema,
  compareExpressionsSchema,
  createDebugSessionSchema,
  cancelTestRunSchema,
  daemonHealthSchema,
  debugBoundarySchema,
  diagnoseCpu2BootSchema,
  evaluateManySchema,
  environmentSchema,
  hardwarePreflightSchema,
  getTestArtifactsSchema,
  getTestRunSchema,
  injectFaultsSchema,
  launchAndRunIpcAcceptanceSchema,
  launchMultiBoardDebugSchema,
  listBoardsSchema,
  recoverBoardSchema,
  listTestRunsSchema,
  launchMulticoreDebugSchema,
  launchMulticoreDebugSafeSchema,
  launchMulticoreDebugWithActionsSchema,
  loadProgramsSchema,
  loadProgramSchema,
  loadSymbolsSchema,
  multicoreSnapshotSchema,
  diagnoseBootHandoffSchema,
  ramOwnershipAnalysisSchema,
  registerBoardSchema,
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
  serverHealthSchema,
  toolContractsSchema,
  submitMultiBoardIpcAcceptanceSchema,
  submitMultiBoardCanAcceptanceSchema,
  listCanProfilesSchema,
  getBoardGroupSnapshotSchema,
  submitCanFaultCampaignSchema,
  submitCanSoakTestSchema,
  submitTestPlanSchema,
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
  | "symbol-load"
  | "memory-write"
  | "launch-workflow"
  | "job-control"
  | "observation-control";

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
  | "workflow"
  | "observability";

export type ToolEffect = "host-read" | "host-write" | "host-process-terminate" | "session-create" | "session-dispose" | "target-read" | "target-connect" | "target-disconnect" | "target-run" | "target-halt" | "target-reset" | "program-load" | "symbol-load" | "target-memory-write" | "ram-ownership-change" | "fault-injection" | "bundle-write";
export type ToolProfile = "readonly" | "safe" | "full";
type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

export interface ToolDefinition {
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
const multiBoardLaunchResponseIdentity = [
  "results[].boardId",
  "results[].probeSerial",
  "results[].sessionId",
  "results[].snapshot.cores[].coreId",
  "results[].snapshot.cores[].coreName"
] as const;

const baseToolDefinitions: Array<Omit<ToolDefinition, "effects" | "annotations" | "approvalClass">> = [
  { name: "c2000_getDaemonHealth", title: "Get C2000 Debug Daemon Health", description: "Return local c2000-debugd health, worker, and background job counts without touching a target.", schema: daemonHealthSchema, handlerName: "getDaemonHealth", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_listBoards", title: "List C2000 Boards", description: "List persisted board registrations, health state, lease ownership, and quarantine evidence. If empty, call c2000_registerBoard before any daemon-routed launch.", schema: listBoardsSchema, handlerName: "listBoards", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_registerBoard", title: "Register C2000 Board", description: "Validate a serial-bound XDS110 .ccxml, persist the board registration, and start its isolated daemon worker without touching the target.", schema: registerBoardSchema, handlerName: "registerBoard", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_recoverBoard", title: "Recover C2000 Board Worker", description: "Dry-run or restart only the daemon-owned worker for one registered board. It never kills external CCS/DSS processes.", schema: recoverBoardSchema, handlerName: "recoverBoard", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_submitTestPlan", title: "Submit C2000 Test Plan", description: "Persist and schedule a structured background test plan; returns immediately with a stable jobId.", schema: submitTestPlanSchema, handlerName: "submitTestPlan", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_submitMultiBoardIpcAcceptance", title: "Submit Multi-Board IPC Acceptance", description: "Create and submit a structured multi-board IPC job without waiting for test completion.", schema: submitMultiBoardIpcAcceptanceSchema, handlerName: "submitMultiBoardIpcAcceptance", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow", coreIdentityFields: ["ipcReadyExpressions[].coreId"] },
  { name: "c2000_submitMultiBoardCanAcceptance", title: "Submit Two-Board CAN Acceptance", description: "Persist a CAN pair and schedule a background two-board CAN test. Hardware mode fails closed until a physical CAN adapter is configured; mock mode is simulation only.", schema: submitMultiBoardCanAcceptanceSchema, handlerName: "submitMultiBoardCanAcceptance", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_getBoardGroupSnapshot", title: "Get Board Group Snapshot", description: "Read durable CAN group lifecycle, member lease/session snapshots, named barriers, and evidence without touching a target.", schema: getBoardGroupSnapshotSchema, handlerName: "getBoardGroupSnapshot", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_listCanProfiles", title: "List CAN Profiles", description: "List versioned, hash-addressable CAN profile declarations without touching a target.", schema: listCanProfilesSchema, handlerName: "listCanProfiles", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_submitCanFaultCampaign", title: "Submit CAN Fault Campaign", description: "Submit a finite, durable two-board CAN fault campaign. Reset/rejoin recovery is never blindly replayed after interruption.", schema: submitCanFaultCampaignSchema, handlerName: "submitCanFaultCampaign", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_submitCanSoakTest", title: "Submit CAN Soak Test", description: "Submit a finite duration/iteration CAN soak job with durable checkpoints; it never runs indefinitely.", schema: submitCanSoakTestSchema, handlerName: "submitCanSoakTest", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_getTestRun", title: "Get C2000 Test Run", description: "Read a durable background test run by jobId.", schema: getTestRunSchema, handlerName: "getTestRun", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_listTestRuns", title: "List C2000 Test Runs", description: "List durable C2000 background test runs.", schema: listTestRunsSchema, handlerName: "listTestRuns", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_cancelTestRun", title: "Cancel C2000 Test Run", description: "Request safe cancellation at the next job step boundary.", schema: cancelTestRunSchema, handlerName: "cancelTestRun", inputScope: "host", targetEffect: "job-control", role: "workflow", family: "workflow" },
  { name: "c2000_getTestArtifacts", title: "Get C2000 Test Artifacts", description: "List durable artifacts attached to a background test run.", schema: getTestArtifactsSchema, handlerName: "getTestArtifacts", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_exportTrace", title: "Export C2000 Perfetto Trace", description: "Atomically export an offline Perfetto timeline from durable SQLite and/or completed artifacts. It never reconnects to a target or changes a job result.", schema: exportTraceSchema, handlerName: "exportTrace", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability" },
  { name: "c2000_collectFailureBundle", title: "Collect C2000 Failure Bundle", description: "Best-effort, timeout-bounded collection of historical job, session, CAN, variable, DLOG, ERAD, and Trace evidence. This is read-only and does not access the target.", schema: collectFailureBundleSchema, handlerName: "collectFailureBundle", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability" },
  { name: "c2000_createRunBaseline", title: "Create C2000 Run Baseline", description: "Generate deterministic metrics from durable job evidence and atomically create a firmware/test-plan-bound baseline. This never touches a target.", schema: createRunBaselineSchema, handlerName: "createRunBaseline", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability" },
  { name: "c2000_compareRunWithBaseline", title: "Compare C2000 Run With Baseline", description: "Compare deterministic run metrics with a compatible baseline using explicit thresholds. Identity mismatches fail closed unless explicitly overridden.", schema: compareRunWithBaselineSchema, handlerName: "compareRunWithBaseline", inputScope: "host", targetEffect: "job-control", role: "primary", family: "observability" },
  { name: "c2000_startVariableStream", title: "Start C2000 Slow Variable Stream", description: "Start one bounded, low-priority host-polled variable stream for one explicit board/session/core. This does not halt the target and is not a high-rate waveform sampler. Prefer variables as {symbol,typeName} objects for deterministic C28x width validation; bare symbol strings are accepted only when the adapter exposes a reliable type.", schema: startVariableStreamSchema, handlerName: "startVariableStream", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_stopVariableStream", title: "Stop C2000 Slow Variable Stream", description: "Idempotently stop or cancel an explicitly identified variable stream.", schema: stopVariableStreamSchema, handlerName: "stopVariableStream", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getVariableStreamStatus", title: "Get C2000 Variable Stream Status", description: "Read persisted stream identity, metadata, statistics, status, and artifact status without touching the target.", schema: getVariableStreamStatusSchema, handlerName: "getVariableStreamStatus", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_readVariableSamples", title: "Read C2000 Variable Samples", description: "Page through ordered variable samples persisted by c2000-debugd without touching the target.", schema: readVariableSamplesSchema, handlerName: "readVariableSamples", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName", "samples[].coreId", "samples[].coreName"] },
  { name: "c2000_exportVariableStream", title: "Export C2000 Variable Stream", description: "Idempotently generate the portable variable-stream evidence snapshot from SQLite.", schema: exportVariableStreamSchema, handlerName: "exportVariableStream", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_describeDlogBuffer", title: "Describe C2000 DLOG Buffer", description: "Resolve and validate a read-only structure-of-arrays DLOG buffer on one explicit board/session/core without reading its samples.", schema: dlogBufferRequestSchema, handlerName: "describeDlogBuffer", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getDlogStatus", title: "Get C2000 DLOG Status", description: "Read DLOG state, write index, trigger index, optional capture generation, and sample rate from one explicit core.", schema: dlogBufferRequestSchema, handlerName: "getDlogStatus", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_readDlogBuffer", title: "Read C2000 DLOG Buffer", description: "Read and normalize an existing target-side DLOG capture with bounded consistency retries. This never arms or modifies firmware.", schema: dlogBufferRequestSchema, handlerName: "readDlogBuffer", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_exportDlog", title: "Export C2000 DLOG", description: "Read a consistent target-side DLOG capture and atomically export dlog.json, dlog.csv, and the standard evidence snapshot.", schema: dlogBufferRequestSchema, handlerName: "exportDlog", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getEradCapabilities", title: "Get F28P65x ERAD Capabilities", description: "Inspect F28P65x ERAD ownership, occupied resources, and supported first-version profiling features on one explicit board/session/core.", schema: getEradCapabilitiesSchema, handlerName: "getEradCapabilities", inputScope: "core", targetEffect: "target-read", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_configureEradProfile", title: "Configure F28P65x ERAD Profile", description: "Resolve a PC range and configure explicitly fenced F28P65x ERAD resources. This writes ERAD registers and never silently overwrites occupied resources.", schema: configureEradProfileSchema, handlerName: "configureEradProfile", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_startEradProfile", title: "Start F28P65x ERAD Profile", description: "Enable a previously configured ERAD profile on its frozen board/session/core and resource set.", schema: startEradProfileSchema, handlerName: "startEradProfile", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_stopEradProfile", title: "Stop F28P65x ERAD Profile", description: "Idempotently stop or cancel an ERAD profile, read counters, and restore the prior selected-resource configuration.", schema: stopEradProfileSchema, handlerName: "stopEradProfile", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_readEradProfile", title: "Read F28P65x ERAD Profile", description: "Read persisted ERAD profile status and completed statistics without touching the target.", schema: readEradProfileSchema, handlerName: "readEradProfile", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_exportEradProfile", title: "Export F28P65x ERAD Profile", description: "Idempotently export erad.json and the standardized atomic evidence snapshot for a terminal profile.", schema: exportEradProfileSchema, handlerName: "exportEradProfile", inputScope: "core", targetEffect: "observation-control", role: "primary", family: "observability", coreIdentityFields: ["coreId"], responseCoreIdentityFields: ["coreId", "coreName"] },
  { name: "c2000_getToolContracts", title: "Get C2000 Tool Contracts", description: "Return tool taxonomy: families, preferred atomic tools vs aliases, and input scope metadata.", schema: toolContractsSchema, handlerName: "getToolContracts", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getServerHealth", title: "Get C2000 Server Health", description: "Return runtime and adapter health without touching a target.", schema: serverHealthSchema, handlerName: "getServerHealth", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
  { name: "c2000_getEnvironment", title: "Get C2000 Environment", description: "Resolve CCS, C2000Ware, and target configuration paths without touching a target.", schema: environmentSchema, handlerName: "getEnvironment", inputScope: "host", targetEffect: "host-read", role: "host", family: "host" },
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
  { name: "c2000_loadSymbols", title: "Load C2000 Symbols Only", description: "Load debug symbols from a .out file into one explicit core session without erasing, programming, or writing target memory. Use for an image already resident in Flash.", schema: loadSymbolsSchema, handlerName: "loadSymbols", inputScope: "core", targetEffect: "symbol-load", role: "primary", family: "program", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_loadPrograms", title: "Load C2000 Programs", description: "Load multiple core programs and return independent per-core results.", schema: loadProgramsSchema, handlerName: "loadPrograms", inputScope: "batch", targetEffect: "program-load", role: "primary", family: "program", coreIdentityFields: ["programs[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_connectCores", title: "Connect C2000 Cores", description: "Connect multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "connectCores", inputScope: "batch", targetEffect: "connectivity-control", role: "primary", family: "connectivity", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_haltCores", title: "Halt C2000 Cores", description: "Halt multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "haltCores", inputScope: "batch", targetEffect: "execution-control", role: "primary", family: "execution", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_resetCores", title: "Reset C2000 Cores", description: "Reset multiple cores by explicit coreIds.", schema: resetCoresSchema, handlerName: "resetCores", inputScope: "batch", targetEffect: "reset-control", role: "primary", family: "reset", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_runCores", title: "Run C2000 Cores", description: "Run multiple cores by explicit coreIds.", schema: batchCoresSchema, handlerName: "runCores", inputScope: "batch", targetEffect: "execution-control", role: "primary", family: "execution", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
  { name: "c2000_getMulticoreSnapshot", title: "Get C2000 Multicore Snapshot", description: "Read state, PC and loaded program for explicit coreIds, defaulting to every core in a session.", schema: multicoreSnapshotSchema, handlerName: "getMulticoreSnapshot", inputScope: "session", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreIds[]"], responseCoreIdentityFields: [...snapshotCoreResponseIdentity] },
  { name: "c2000_evaluateMany", title: "Evaluate C2000 Expressions", description: "Evaluate multiple expressions on one explicit core with independent results.", schema: evaluateManySchema, handlerName: "evaluateMany", inputScope: "core", targetEffect: "target-read", role: "primary", family: "read", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...coreOnlyResponseIdentity] },
  { name: "c2000_assignExpression", title: "Assign C2000 Expression", description: "Assign a value expression on one explicit core for fault injection or parameter synchronization checks. Use verification=write-only for a one-shot firmware hook that consumes the value immediately.", schema: assignExpressionSchema, handlerName: "assignExpression", inputScope: "core", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["coreId"], responseCoreIdentityFields: [...singleCoreResponseIdentity] },
  { name: "c2000_assignExpressions", title: "Assign C2000 Expressions", description: "Assign multiple explicit per-core expressions for fault injection, MSGRAM, IPC, or parameter synchronization setup. Each item may use verification=write-only for a one-shot hook.", schema: assignExpressionsSchema, handlerName: "assignExpressions", inputScope: "batch", targetEffect: "memory-write", role: "primary", family: "write", coreIdentityFields: ["assignments[].coreId"], responseCoreIdentityFields: [...batchCoreResponseIdentity] },
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
  { name: "c2000_launchAndRunIpcAcceptance", title: "Launch And Run C2000 IPC Acceptance", description: "Preferred one-shot after c2000_listBoards confirms a registered worker: create and connect CPU1/CPU2 (standard coreIds 0 and 2), then run full IPC acceptance. The server validates the load/run contract and real-map IPC symbols before target mutation. For RAM builds that initialize ownership from CPU1, use loadSequence.mode=cpu1-run-before-cpu2.", schema: launchAndRunIpcAcceptanceSchema, handlerName: "launchAndRunIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...launchAndRunIpcAcceptanceResponseIdentity] },
  { name: "c2000_runIpcAcceptance", title: "Run C2000 IPC Acceptance Workflow", description: "Preferred when session already exists: full F28P65x CPU1/CPU2 IPC acceptance in one server-side call. The server validates the load/run contract and real-map IPC symbols before target mutation; use this workflow instead of launchMulticoreDebug followed by generic runCores for an IPC handshake.", schema: runIpcAcceptanceSchema, handlerName: "runIpcAcceptance", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "ipcReadyExpressions[].coreId"], responseCoreIdentityFields: [...workflowIpcAcceptanceResponseIdentity] },
  { name: "c2000_runBootHandoffDiagnosis", title: "Run C2000 Boot Handoff Diagnosis Workflow", description: "Preferred boot diagnosis: snapshot, programs, expressions, PC, RAM ownership, ELF freshness, and CPU2 handoff in one workflow.", schema: runBootHandoffDiagnosisSchema, handlerName: "runBootHandoffDiagnosis", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "expressions[].coreId"], responseCoreIdentityFields: [...workflowBootHandoffResponseIdentity] },
  { name: "c2000_runReloadAndDiagnose", title: "Run C2000 Reload And Diagnose Workflow", description: "Preferred reload path: halt/reset/load, optionally perform a controlled post-load reset and CPU1-first boot, wait, then diagnose in one workflow. The post-load boot does not write PC or claim Flash verification.", schema: runReloadAndDiagnoseSchema, handlerName: "runReloadAndDiagnose", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "waitExpressions[].coreId"], responseCoreIdentityFields: [...workflowReloadAndDiagnoseResponseIdentity] },
  { name: "c2000_runFullDebugBundle", title: "Run C2000 Full Debug Bundle Workflow", description: "Preferred evidence capture: full multicore debug bundle with summary files in one workflow.", schema: runFullDebugBundleSchema, handlerName: "runFullDebugBundle", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId", "coreIds[]", "expressions[].coreId", "maps[].coreId"], responseCoreIdentityFields: [...workflowFullBundleResponseIdentity] },
  { name: "c2000_verifyRunPauseIsolation", title: "Verify C2000 Run/Pause Isolation", description: "Run and pause CPU1/CPU2 one at a time, proving each command affects only the requested core.", schema: verifyRunPauseIsolationSchema, handlerName: "verifyRunPauseIsolation", inputScope: "session", targetEffect: "execution-control", role: "diagnostic", family: "execution", coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"], responseCoreIdentityFields: [...runPauseAcceptanceResponseIdentity] },
  { name: "c2000_launchMultiBoardDebug", title: "Launch C2000 Multi-Board Debug", description: "Allocate explicit XDS110 serial numbers to independently bound .ccxml configurations, then create isolated multicore sessions for every connected board in one MCP call. Sessions auto-close after the requested idle timeout by default.", schema: launchMultiBoardDebugSchema, handlerName: "launchMultiBoardDebug", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["boards[].cores[].coreId"], responseCoreIdentityFields: [...multiBoardLaunchResponseIdentity] },
  { name: "c2000_launchMulticoreDebug", title: "Launch C2000 Multicore Debug", description: "Create, connect, load and snapshot a multicore debug flow. The session and its DSS process auto-close after the requested idle timeout by default; set autoCloseOnComplete=false for an interactive session. Prefer workflow tools for IPC/boot diagnosis after launch.", schema: launchMulticoreDebugSchema, handlerName: "launchMulticoreDebug", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: [
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
  { name: "c2000_launchMulticoreDebugSafe", title: "Launch C2000 Multicore Debug Safely", description: "After confirming board registration, create, connect, load, halt, snapshot and perform read-only checks without expression writes, fault injection, reset or automatic run. F28P65x CPU1/CPU2 use coreIds 0/2.", schema: launchMulticoreDebugSafeSchema, handlerName: "launchMulticoreDebugSafe", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cores[].coreId"], responseCoreIdentityFields: [...launchResponseIdentity] },
  { name: "c2000_launchMulticoreDebugWithActions", title: "Launch C2000 Multicore Debug With Target Actions", description: "Create and launch a multicore session with explicit target mutations including assignments, fault injection, or run/pause isolation.", schema: launchMulticoreDebugWithActionsSchema, handlerName: "launchMulticoreDebugWithActions", inputScope: "launch", targetEffect: "launch-workflow", role: "workflow", family: "workflow", coreIdentityFields: ["cores[].coreId"], responseCoreIdentityFields: [...launchResponseIdentity] }
];

export const c2000ToolDefinitions: ToolDefinition[] = baseToolDefinitions.map(definition => decorateDefinition(definition));

export interface C2000ToolInvoker {
  invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>>;
}

export function createC2000ToolInvoker(
  manager: DebugSessionManager,
  deps: ToolHandlerDeps = {}
): C2000ToolInvoker {
  const handlers = createToolHandlers(manager, { getToolContracts, getToolSurfaceGuide, ...deps });
  const definitions = new Map(c2000ToolDefinitions.map(definition => [definition.name, definition]));

  return {
    async invokeTool(toolName: string, input: unknown): Promise<Record<string, unknown>> {
      const definition = definitions.get(toolName);
      const sessionId = getInputSessionId(input);
      if (!definition) {
        return failedInvocation(new DebugMcpError("ToolNotFound", `Unknown C2000 tool: ${toolName}`, { toolName }), sessionId);
      }
      try {
        // The daemon validates again even when a proxy has already checked this input.
        const parsedInput = definition.schema.parse(input);
        const handler = handlers[definition.handlerName] as Handler;
        // Several workflow wrappers intentionally call sibling handlers through
        // `this`; preserve the handler object when invoking through the generic router.
        const invoke = () => handler.call(handlers, parsedInput);
        return typeof sessionId === "string" && definition.name !== "c2000_closeDebugSession"
          ? await manager.withSessionActivity(sessionId, invoke)
          : await invoke();
      } catch (error) {
        return failedInvocation(error, sessionId);
      }
    }
  };
}

export function registerC2000Tools(
  server: McpServer,
  source: DebugSessionManager | C2000ToolInvoker,
  deps: ToolHandlerDeps = {},
  profile: ToolProfile = toolProfileFromEnv(),
  filesystem: FilesystemPolicy = { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] },
  tiEnvironment: ResolveTiEnvironmentOptions = {},
  runtime: { getServerHealth?: () => Record<string, any> } = {}
) {
  const registered = definitionsForProfile(profile);
  const effectiveDeps: ToolHandlerDeps = {
    getToolContracts: () => getToolContracts(profile),
    getToolSurfaceGuide: () => getToolSurfaceGuide(),
    getToolProfile: () => ({ activeToolProfile: profile, hiddenTools: c2000ToolDefinitions.filter(tool => !registered.includes(tool)).map(tool => tool.name), profileReason: `C2000_MCP_TOOL_PROFILE=${profile}` }),
    getServerHealth: runtime.getServerHealth,
    tiEnvironment,
    ...deps
  };
  const invoker = isToolInvoker(source) ? source : createC2000ToolInvoker(source, effectiveDeps);

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
        let result: Record<string, unknown>;
        try {
          await validateToolPaths(input, filesystem);
          result = await invoker.invokeTool(definition.name, input);
        } catch (error) {
          result = failedInvocation(error, getInputSessionId(input));
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: result.success === false
        };
      }
    );
  }
}

function isToolInvoker(value: DebugSessionManager | C2000ToolInvoker): value is C2000ToolInvoker {
  return typeof (value as C2000ToolInvoker).invokeTool === "function";
}

function getInputSessionId(input: unknown): string | undefined {
  return input && typeof input === "object" && typeof (input as { sessionId?: unknown }).sessionId === "string"
    ? (input as { sessionId: string }).sessionId
    : undefined;
}

function failedInvocation(error: unknown, sessionId?: string): Record<string, unknown> {
  return {
    success: false,
    timestamp: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
    error: toStructuredError(error)
  };
}

export function getToolContracts(profile: ToolProfile = "full") {
  return definitionsForProfile(profile).map(definition => {
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
      "Use host tools (readiness/preflight/boundary) before target-touching acceptance.",
      "For daemon-routed hardware, call c2000_getDaemonHealth and c2000_listBoards first. If no board is registered, stop and call c2000_registerBoard; do not try alternate launch tools.",
      "Use F28P65x coreId 0 for C28xx_CPU1 and coreId 2 for C28xx_CPU2.",
      "Use exact CCS corePattern selectors C28xx_CPU1 and C28xx_CPU2; do not send regular expressions.",
      "For a CPU2 RAM image that requires CPU1 ownership initialization, explicitly use loadSequence.mode=cpu1-run-before-cpu2.",
      "Set runSequence.runMode (or durable runIpcAcceptance.runMode) explicitly; when present it is authoritative and contradictory legacy runCpu1First/runCpu2 values are rejected.",
      "Do not combine runMode=cpu2_pre_running with loadSequence.mode=cpu1-run-before-cpu2; the server rejects this before target mutation.",
      "Use c2000_runIpcAcceptance or c2000_launchAndRunIpcAcceptance for IPC startup; launchMulticoreDebug followed by generic runCores does not perform the boot-handoff contract.",
      "For one-shot firmware hooks, set assignment.verification=write-only; ordinary assignments keep readback verification by default.",
      "If firmware is already resident in Flash, use c2000_loadSymbols; do not use c2000_loadProgram as a symbol-only substitute.",
      "outputDir must be inside a configured allowedWriteRoots path; program, map, and ccxml files must be inside allowedReadRoots."
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
  if (targetEffect === "observation-control") {
    if (name === "c2000_exportTrace" || name === "c2000_collectFailureBundle" || name === "c2000_createRunBaseline" || name === "c2000_compareRunWithBaseline") return ["host-read", "bundle-write"];
    if (name === "c2000_startVariableStream") return ["target-read", "bundle-write"];
    if (name === "c2000_exportVariableStream") return ["bundle-write"];
    if (name === "c2000_stopVariableStream") return ["host-write"];
    if (name === "c2000_exportDlog") return ["target-read", "bundle-write"];
    if (name === "c2000_describeDlogBuffer" || name === "c2000_getDlogStatus" || name === "c2000_readDlogBuffer") return ["target-read"];
    if (name === "c2000_exportEradProfile") return ["bundle-write"];
    if (name === "c2000_readEradProfile") return ["host-read"];
    return ["host-read"];
  }
  if (targetEffect === "host-read" || targetEffect === "session-read") return ["host-read"];
  if (name === "c2000_createDebugSession") return ["session-create", "host-process-terminate"];
  if (name === "c2000_closeDebugSession") return ["session-dispose"];
  if (targetEffect === "target-read") return ["target-read"];
  if (targetEffect === "connectivity-control") return [name.includes("disconnect") ? "target-disconnect" : "target-connect"];
  if (targetEffect === "reset-control") return ["target-reset"];
  if (targetEffect === "program-load") return ["program-load", "ram-ownership-change"];
  if (targetEffect === "symbol-load") return ["symbol-load"];
  if (targetEffect === "memory-write") return name.includes("injectFault") ? ["target-memory-write", "fault-injection"] : ["target-memory-write"];
  if (targetEffect === "job-control") {
    if (name === "c2000_recoverBoard") return ["host-process-terminate"];
    if (name === "c2000_exportTrace" || name === "c2000_collectFailureBundle" || name === "c2000_createRunBaseline" || name === "c2000_compareRunWithBaseline") return ["host-read", "bundle-write"];
    return ["host-write"];
  }
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

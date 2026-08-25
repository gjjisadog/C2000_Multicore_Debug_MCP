import { createHash } from "node:crypto";
import { readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import { DURABLE_PLAN_LIMITS, parsePersistedTestPlan, resolveArtifactsForBoard } from "../jobs/TestPlanSchema.js";
import { SERVER_VERSION } from "../runtimeInfo.js";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import type { ArtifactExportRepository } from "../storage/repositories/ArtifactExportRepository.js";
import type { BoardRepository } from "../storage/repositories/BoardRepository.js";
import type { EventRepository } from "../storage/repositories/EventRepository.js";
import type { SessionRepository } from "../storage/repositories/SessionRepository.js";
import type { TestRunRepository, TestStepRecord } from "../storage/repositories/TestRunRepository.js";
import type { WorkerRepository } from "../storage/repositories/WorkerRepository.js";
import { sanitizeEvidence } from "../observability/SensitiveDataFilter.js";
import { toStructuredError } from "../utils/errors.js";
import { AtomicArtifactWriter } from "./AtomicArtifactWriter.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  artifactEventSchema,
  artifactManifestSchema,
  artifactResultSchema,
  targetStateEventSchema,
  type ArtifactEvent,
  type ArtifactManifest,
  type ArtifactResult,
  type TargetStateEvent
} from "./ArtifactSchemas.js";

const TERMINAL_STATUSES = new Set(["PASSED", "FAILED", "PARTIAL", "CANCELLED", "NEEDS_MANUAL_INTERVENTION"]);

export class JobArtifactSnapshotService {
  private readonly writer: AtomicArtifactWriter;

  constructor(private readonly options: {
    rootDirectory: string;
    config: C2000McpConfig;
    runs: TestRunRepository;
    boards: BoardRepository;
    sessions: SessionRepository;
    workers: WorkerRepository;
    events: EventRepository;
    artifacts: ArtifactRepository;
    exports: ArtifactExportRepository;
    writer?: AtomicArtifactWriter;
    postCommitFileMetadata?: (filePath: string) => Promise<{ size: number; sha256: string }>;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async exportJob(jobId: string): Promise<string> {
    const run = this.options.runs.get(jobId);
    if (!run) throw new Error(`Test run not found: ${jobId}`);
    if (!TERMINAL_STATUSES.has(run.status)) throw new Error(`Test run is not terminal: ${jobId} (${run.status})`);
    const artifactDirectory = this.jobDirectory(jobId);
    const manifestPath = path.join(artifactDirectory, "manifest.json");
    const previousManifestPath = path.join(artifactDirectory, ".manifest.previous");
    const expressionSnapshotPath = path.join(artifactDirectory, "expression-snapshots.json");
    const previousExpressionSnapshotPath = path.join(artifactDirectory, ".expression-snapshots.previous");
    const preCleanupDiagnosticsPath = path.join(artifactDirectory, "pre-cleanup-launch-diagnostics.json");
    let previousExpressionSnapshotSaved = false;
    let manifestPublished = false;
    this.options.exports.upsert({
      jobId,
      rootPath: artifactDirectory,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      status: "EXPORTING",
      completeness: "INCOMPLETE",
      updatedAt: new Date().toISOString()
    });
    try {
      await this.writer.ensureDirectory(path.join(artifactDirectory, "attachments"));
      if (await this.writer.exists(manifestPath)) {
        await rm(previousManifestPath, { force: true });
        await rename(manifestPath, previousManifestPath);
      }
      if (await this.writer.exists(expressionSnapshotPath)) {
        await rm(previousExpressionSnapshotPath, { force: true });
        await rename(expressionSnapshotPath, previousExpressionSnapshotPath);
        previousExpressionSnapshotSaved = true;
      }
      const snapshot = await this.buildSnapshot(jobId);
      const preCleanupDiagnostics = preCleanupLaunchEvidence(jobId, this.options.runs.steps(jobId));
      if (preCleanupDiagnostics) {
        await this.writer.writeJson(preCleanupDiagnosticsPath, preCleanupDiagnostics);
        const diagnosticsInfo = await this.postCommitFileMetadata(preCleanupDiagnosticsPath);
        snapshot.manifest.generatedFiles = [
          ...(snapshot.manifest.generatedFiles ?? []).filter(file => file.path !== "pre-cleanup-launch-diagnostics.json"),
          {
            path: "pre-cleanup-launch-diagnostics.json",
            artifactType: "evidence:pre-cleanup-launch-diagnostics",
            sha256: diagnosticsInfo.sha256,
            size: diagnosticsInfo.size,
            completeness: "COMPLETE"
          }
        ];
      } else {
        await rm(preCleanupDiagnosticsPath, { force: true });
        snapshot.manifest.generatedFiles = snapshot.manifest.generatedFiles?.filter(file => file.path !== "pre-cleanup-launch-diagnostics.json");
      }
      const previousManifest = await readJsonRecord(previousManifestPath);
      if (Array.isArray(previousManifest?.generatedFiles)) {
        const previousGeneratedFiles = previousManifest.generatedFiles.flatMap(value => {
          const parsed = artifactManifestSchema.shape.generatedFiles.unwrap().element.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        const currentGeneratedFiles = snapshot.manifest.generatedFiles ?? [];
        const currentPaths = new Set(currentGeneratedFiles.map(file => file.path));
        snapshot.manifest.generatedFiles = [
          ...previousGeneratedFiles.filter(file => !currentPaths.has(file.path)),
          ...currentGeneratedFiles
        ];
      }
      if (snapshot.expressionSnapshots.length > 0) {
        await this.writer.writeJson(expressionSnapshotPath, {
          schemaVersion: ARTIFACT_SCHEMA_VERSION,
          jobId,
          snapshots: snapshot.expressionSnapshots
        });
        const expressionInfo = await stat(expressionSnapshotPath);
        const expressionSha = await sha256File(expressionSnapshotPath);
        if (!expressionSha) throw new Error("Expression snapshot hash is unavailable after atomic publication");
        snapshot.manifest.generatedFiles = [
          ...(snapshot.manifest.generatedFiles ?? []).filter(file => file.path !== "expression-snapshots.json"),
          {
            path: "expression-snapshots.json",
            artifactType: "evidence:expression-snapshots",
            sha256: expressionSha,
            size: expressionInfo.size,
            completeness: "COMPLETE"
          }
        ];
      } else {
        await rm(expressionSnapshotPath, { force: true });
        snapshot.manifest.generatedFiles = snapshot.manifest.generatedFiles?.filter(file => file.path !== "expression-snapshots.json");
      }
      artifactResultSchema.parse(snapshot.result);
      artifactManifestSchema.parse(snapshot.manifest);
      snapshot.events.forEach(event => artifactEventSchema.parse(event));
      snapshot.targetStates.forEach(event => targetStateEventSchema.parse(event));

      await this.writer.writeJson(path.join(artifactDirectory, "result.json"), snapshot.result);
      await this.writer.writeJsonLines(path.join(artifactDirectory, "events.jsonl"), snapshot.events);
      if (snapshot.targetStates.length > 0) {
        await this.writer.writeJsonLines(path.join(artifactDirectory, "target-state.jsonl"), snapshot.targetStates);
      } else {
        await rm(path.join(artifactDirectory, "target-state.jsonl"), { force: true });
      }
      await this.writer.writeText(path.join(artifactDirectory, "summary.md"), renderSummary(snapshot.manifest, snapshot.result));
      // The manifest is the commit marker and is deliberately published last.
      await this.writer.writeJson(manifestPath, snapshot.manifest);
      manifestPublished = true;
      await rm(previousManifestPath, { force: true });
      await rm(previousExpressionSnapshotPath, { force: true });
      await this.registerStandardFiles(jobId, artifactDirectory);
      if (snapshot.expressionSnapshots.length > 0) {
        const expressionInfo = await this.postCommitFileMetadata(expressionSnapshotPath);
        this.options.artifacts.upsert({
          jobId,
          artifactType: "evidence:expression-snapshots",
          path: expressionSnapshotPath,
          sha256: expressionInfo.sha256,
          size: expressionInfo.size,
          createdAt: run.finishedAt ?? run.submittedAt
        });
      }
      this.options.exports.upsert({
        jobId,
        rootPath: artifactDirectory,
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        status: "EXPORTED",
        completeness: snapshot.manifest.completeness.status,
        updatedAt: run.finishedAt ?? run.submittedAt
      });
      return artifactDirectory;
    } catch (error) {
      if (!manifestPublished) {
        if (!await this.writer.exists(manifestPath) && await this.writer.exists(previousManifestPath)) {
          await rename(previousManifestPath, manifestPath).catch(() => undefined);
        }
        if (previousExpressionSnapshotSaved) {
          await rm(expressionSnapshotPath, { force: true }).catch(() => undefined);
          await rename(previousExpressionSnapshotPath, expressionSnapshotPath).catch(() => undefined);
        } else {
          await rm(expressionSnapshotPath, { force: true }).catch(() => undefined);
        }
      } else {
        // The manifest is the publication commit. Index/registration failures
        // after this point must never roll back a file referenced by it.
        await rm(previousManifestPath, { force: true }).catch(() => undefined);
        await rm(previousExpressionSnapshotPath, { force: true }).catch(() => undefined);
      }
      this.options.exports.upsert({
        jobId,
        rootPath: artifactDirectory,
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        status: "FAILED",
        completeness: "ARTIFACT_FAILED",
        lastError: { ...toStructuredError(error) },
        updatedAt: new Date().toISOString()
      });
      throw error;
    }
  }

  async recoverExisting(): Promise<void> {
    for (const run of this.options.runs.list().filter(candidate => TERMINAL_STATUSES.has(candidate.status))) {
      const manifestPath = path.join(this.jobDirectory(run.jobId), "manifest.json");
      const exportRecord = this.options.exports.get(run.jobId);
      if (exportRecord?.status === "EXPORTED" && await this.writer.exists(manifestPath)) continue;
      await this.exportJob(run.jobId).catch(() => undefined);
    }
  }

  jobDirectory(jobId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error("Unsafe jobId for artifact path");
    return path.join(path.resolve(this.options.rootDirectory), jobId);
  }

  private async buildSnapshot(jobId: string): Promise<{
    manifest: ArtifactManifest;
    result: ArtifactResult;
    events: ArtifactEvent[];
    targetStates: TargetStateEvent[];
    expressionSnapshots: Record<string, unknown>[];
  }> {
    const run = this.options.runs.get(jobId)!;
    const plan = parsePersistedTestPlan(run.plan);
    const runBoards = this.options.runs.boards(jobId);
    const steps = this.options.runs.steps(jobId);
    const { expressionSnapshots, durableStepResults } = portableDurableEvidenceFromSteps(steps);
    const portableEvidenceBytes = Buffer.byteLength(JSON.stringify({ expressionSnapshots, durableStepResults }), "utf8");
    if (portableEvidenceBytes > DURABLE_PLAN_LIMITS.maxJobEvidenceBytes) {
      throw new Error(`Portable durable evidence exceeds ${DURABLE_PLAN_LIMITS.maxJobEvidenceBytes} bytes`);
    }
    const targetContext = await Promise.all(runBoards.map(async runBoard => {
      const board = this.options.boards.require(runBoard.boardId);
      const session = runBoard.sessionId
        ? this.options.sessions.get(runBoard.sessionId)
        : this.options.sessions.listByBoard(runBoard.boardId)[0];
      const worker = session?.workerInstanceId
        ? this.options.workers.get(session.workerInstanceId)
        : board.currentWorkerInstanceId ? this.options.workers.get(board.currentWorkerInstanceId) : undefined;
      const cores = normalizeCores(session?.coreMap.length ? session.coreMap : this.options.config.target.coreMap);
      const artifacts = resolveArtifactsForBoard(plan, runBoard.boardId);
      const programs = artifacts ? await Promise.all([
        programEvidence(cores, 0, artifacts.cpu1OutPath, artifacts.cpu1MapPath),
        programEvidence(cores, 2, artifacts.cpu2OutPath, artifacts.cpu2MapPath)
      ]) : [];
      return { runBoard, board, session, worker, cores, programs };
    }));
    const targetEvidence = targetContext.map(context => ({
      ...context,
      adapterEvidence: buildAdapterEvidence(
        this.options.config,
        context.runBoard.boardId,
        context.board.probeSerial,
        context.session,
        durableStepResults
      )
    }));
    const evidenceClassification = combineEvidenceClassification(targetEvidence.map(context => context.adapterEvidence.classification));

    const cancelled = run.status === "CANCELLED";
    const missingProgramHash = targetContext.some(context => context.programs.some(program =>
      program.outSha256 === null || (program.mapPath !== null && program.mapSha256 === null)
    ));
    const incompleteReason = cancelled
      ? "JOB_CANCELLED"
      : missingProgramHash ? "PROGRAM_OR_MAP_HASH_UNAVAILABLE" : null;
    const completeness = incompleteReason
      ? { status: "INCOMPLETE" as const, reason: incompleteReason }
      : { status: "COMPLETE" as const, reason: null };
    const manifest: ArtifactManifest = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId,
      jobType: run.planName,
      targets: targetEvidence.map(({ board, session, worker, cores, programs, adapterEvidence }) => ({
        boardId: board.boardId,
        boardProfile: { device: board.device, tags: [...board.tags].sort() },
        xds110Serial: board.probeSerial,
        adapterType: adapterEvidence.effectiveAdapterType ?? "auto",
        configuredAdapterMode: adapterEvidence.configuredAdapterMode,
        configuredScriptingMode: adapterEvidence.configuredScriptingMode,
        effectiveAdapterType: adapterEvidence.effectiveAdapterType,
        adapterEvidence,
        workerGeneration: worker?.workerGeneration ?? null,
        adapterSessionId: session?.adapterSessionId ?? null,
        sessionId: session?.sessionId ?? null,
        cores,
        programs
      })),
      mcpVersion: SERVER_VERSION,
      nodeVersion: process.version,
      operatingSystem: { platform: os.platform(), release: os.release(), architecture: os.arch() },
      ccsVersion: null,
      configSummary: {
        planVersion: run.planVersion,
        priority: plan.priority,
        parallelism: plan.parallelism ?? null,
        failurePolicy: plan.failurePolicy,
        recoveryPolicy: plan.recoveryPolicy,
        adapterType: targetEvidence.length === 1 ? (targetEvidence[0]!.adapterEvidence.effectiveAdapterType ?? "auto") : "auto",
        configuredAdapterMode: this.options.config.adapter,
        configuredScriptingMode: this.options.config.ccs.scriptingMode,
        effectiveAdapterType: targetEvidence.length === 1 ? targetEvidence[0]!.adapterEvidence.effectiveAdapterType : null
      },
      startedAt: run.startedAt ?? run.submittedAt,
      endedAt: run.finishedAt ?? run.submittedAt,
      evidenceLevel: evidenceClassification,
      evidenceClassification,
      adapterEvidence: { targets: targetEvidence.map(context => context.adapterEvidence) },
      completeness,
      durableStepResults
    };
    const failedStep = steps.find(step => step.status === "FAILED");
    const error = failedStep?.error ?? run.error;
    const errorCode = typeof error?.code === "string" ? error.code : null;
    const result: ArtifactResult = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      jobId,
      overallStatus: run.status,
      errorCode,
      failedStep: failedStep ? { boardId: failedStep.boardId, stepIndex: failedStep.stepIndex, stepType: failedStep.stepType } : null,
      assertions: steps.map(step => ({
        name: `${step.boardId}:${step.stepIndex}:${step.stepType}`,
        status: assertionStatus(step),
        ...(typeof step.error?.message === "string" ? { message: step.error.message } : {})
      })),
      evidenceClassification,
      cancelled,
      timedOut: Boolean(errorCode && /timeout/i.test(errorCode)),
      incompleteReason,
      expressionSnapshotCount: expressionSnapshots.length
    };

    const sessionByBoard = new Map(targetContext.map(context => [context.board.boardId, context]));
    const events = this.options.events.list({ jobId, limit: 1_000_000, ascending: true }).map((event, index): ArtifactEvent => {
      const context = event.boardId ? sessionByBoard.get(event.boardId) : undefined;
      const payload = sanitize(event.payload);
      return {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        sequence: event.sequence ?? index + 1,
        jobId,
        eventType: event.eventType,
        timestamp: event.timestamp,
        monotonicTimestampNs: event.monotonicTimestampNs ?? String(index + 1),
        source: { type: event.sourceType, id: event.sourceId },
        boardId: event.boardId ?? null,
        workerGeneration: event.workerGeneration ?? context?.worker?.workerGeneration ?? null,
        adapterSessionId: stringOrNull(payload.adapterSessionId) ?? context?.session?.adapterSessionId ?? null,
        sessionId: stringOrNull(payload.sessionId) ?? context?.session?.sessionId ?? null,
        coreId: numberOrNull(payload.coreId),
        coreName: stringOrNull(payload.coreName),
        payload
      };
    });
    const targetStates = targetContext.flatMap((context, index): TargetStateEvent[] => {
      const snapshot = context.session?.lastSnapshot;
      const cores = snapshot && Array.isArray(snapshot.cores) ? snapshot.cores.filter(isRecord) : [];
      if (!context.session || cores.length === 0) return [];
      return [{
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        sequence: index + 1,
        jobId,
        timestamp: context.session.closedAt ?? context.session.createdAt,
        boardId: context.board.boardId,
        workerGeneration: context.worker?.workerGeneration ?? null,
        adapterSessionId: context.session.adapterSessionId ?? null,
        sessionId: context.session.sessionId,
        cores: cores.map(core => sanitize(core))
      }];
    });
    return { manifest, result, events, targetStates, expressionSnapshots };
  }

  private async registerStandardFiles(jobId: string, directory: string): Promise<void> {
    for (const fileName of ["manifest.json", "result.json", "events.jsonl", "target-state.jsonl", "summary.md", "pre-cleanup-launch-diagnostics.json"]) {
      const filePath = path.join(directory, fileName);
      if (!await this.writer.exists(filePath)) continue;
      const info = await this.postCommitFileMetadata(filePath);
      this.options.artifacts.upsert({
        jobId,
        artifactType: `standard:${fileName}`,
        path: filePath,
        sha256: info.sha256,
        size: info.size,
        createdAt: this.options.runs.get(jobId)?.finishedAt ?? new Date().toISOString()
      });
    }
  }

  private async postCommitFileMetadata(filePath: string): Promise<{ size: number; sha256: string }> {
    if (this.options.postCommitFileMetadata) return this.options.postCommitFileMetadata(filePath);
    const info = await stat(filePath);
    const sha256 = await sha256File(filePath);
    if (!sha256) throw new Error(`Committed artifact hash is unavailable: ${filePath}`);
    return { size: info.size, sha256 };
  }
}

async function programEvidence(cores: Array<{ coreId: number; coreName: string }>, coreId: number, outPath: string, mapPath?: string) {
  const core = cores.find(candidate => candidate.coreId === coreId) ?? { coreId, coreName: coreId === 0 ? "C28xx_CPU1" : "C28xx_CPU2" };
  return {
    ...core,
    outPath: path.normalize(path.resolve(outPath)),
    outSha256: await sha256File(outPath),
    mapPath: mapPath ? path.normalize(path.resolve(mapPath)) : null,
    mapSha256: mapPath ? await sha256File(mapPath) : null
  };
}

async function sha256File(filePath: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function normalizeCores(values: unknown[]): Array<{ coreId: number; coreName: string }> {
  return values.filter(isRecord).flatMap(value => {
    const coreId = numberOrNull(value.coreId);
    const coreName = stringOrNull(value.coreName);
    return coreId === null || coreName === null ? [] : [{ coreId, coreName }];
  });
}

function assertionStatus(step: TestStepRecord): "PASSED" | "FAILED" | "SKIPPED" {
  if (step.status === "PASSED") return "PASSED";
  if (step.status === "FAILED") return "FAILED";
  return "SKIPPED";
}

function preCleanupLaunchEvidence(jobId: string, steps: TestStepRecord[]): Record<string, unknown> | undefined {
  const launchStep = steps.find(step => step.stepType === "launchMulticore" && isRecord(step.output?.preCleanupDiagnostics));
  const diagnostics = launchStep?.output?.preCleanupDiagnostics;
  if (!launchStep || !isRecord(diagnostics)) return undefined;
  return sanitize({
    schemaVersion: 1,
    jobId,
    boardId: launchStep.boardId,
    stepIndex: launchStep.stepIndex,
    stepStatus: launchStep.status,
    provenance: {
      source: "durable-step-output",
      captureSource: "live-pre-cleanup-session",
      capturedBeforeSessionClose: true,
      collectorTargetAccessed: false
    },
    diagnostics
  });
}

export function portableDurableEvidenceFromSteps(steps: TestStepRecord[]): {
  expressionSnapshots: Record<string, unknown>[];
  durableStepResults: Record<string, unknown>[];
} {
  return {
    expressionSnapshots: expressionSnapshotsFromSteps(steps),
    durableStepResults: durableStepResultsFromSteps(steps)
  };
}

function expressionSnapshotsFromSteps(steps: TestStepRecord[]): Record<string, unknown>[] {
  return steps.flatMap(step => {
    const snapshots = step.output?.expressionSnapshots;
    if (!Array.isArray(snapshots)) return [];
    return snapshots.filter(isRecord).map(snapshot => sanitize({
      ...snapshot,
      boardId: step.boardId,
      stepIndex: step.stepIndex,
      stepType: step.stepType
    }));
  });
}

function durableStepResultsFromSteps(steps: TestStepRecord[]): Record<string, unknown>[] {
  const durableTypes = new Set([
    "preflight", "launchMulticore", "assignExpressions", "injectFaults", "captureExpressions", "waitForExpressions",
    "runCores", "haltCores", "reconnectAfterTargetReset", "restorePrograms", "resetReconnectCapture",
    "runIpcAcceptance", "runBootHandoffDiagnosis", "runReloadAndDiagnose", "runFullDebugBundle", "cleanup", "delay"
  ]);
  return steps.filter(step => durableTypes.has(step.stepType)).map(step => {
    const output = step.output ? sanitize(step.output) : undefined;
    const { expressionSnapshots: snapshots, ...outputWithoutSnapshots } = output ?? {};
    return {
      boardId: step.boardId,
      stepIndex: step.stepIndex,
      stepType: step.stepType,
      status: step.status,
      attempt: step.attempt,
      input: sanitize(step.input),
      ...(output ? { output: { ...outputWithoutSnapshots, ...(Array.isArray(snapshots) ? { expressionSnapshotCount: snapshots.length } : {}) } } : {}),
      ...(step.error ? { error: sanitize(step.error) } : {})
    };
  });
}

function sanitize(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeEvidence(value);
}

function renderSummary(manifest: ArtifactManifest, result: ArtifactResult): string {
  const targets = manifest.targets.map(target => `- ${target.boardId} (${target.boardProfile.device}, XDS110 ${target.xds110Serial})`).join("\n");
  const adapterEvidence = manifest.adapterEvidence && isRecord(manifest.adapterEvidence)
    ? JSON.stringify(manifest.adapterEvidence)
    : "n/a";
  return `# Test evidence summary

- Job: ${manifest.jobId}
- Type: ${manifest.jobType}
- Status: ${result.overallStatus}
- Evidence: ${result.evidenceClassification}
- Configured adapter: ${String(manifest.configSummary.configuredAdapterMode ?? "unknown")} / scripting=${String(manifest.configSummary.configuredScriptingMode ?? "unknown")}
- Effective adapter: ${String(manifest.configSummary.effectiveAdapterType ?? "unknown")}
- Adapter evidence: ${adapterEvidence}
- Artifact completeness: ${manifest.completeness.status}
- Started: ${manifest.startedAt}
- Ended: ${manifest.endedAt}

## Targets

${targets}

## Assertions

- Passed: ${result.assertions.filter(assertion => assertion.status === "PASSED").length}
- Failed: ${result.assertions.filter(assertion => assertion.status === "FAILED").length}
- Skipped: ${result.assertions.filter(assertion => assertion.status === "SKIPPED").length}

This summary is generated from manifest.json and result.json; those structured files and events.jsonl are the evidence sources.
`;
}

type EffectiveAdapterType = "ccs" | "mock";
type EvidenceClassification = "MOCK" | "HARDWARE_TARGET" | "UNKNOWN" | "MIXED";

export function buildAdapterEvidence(
  config: C2000McpConfig,
  boardId: string,
  probeSerial: string,
  session: { sessionId: string; adapterSessionId?: string } | undefined,
  steps: Record<string, unknown>[]
): Record<string, unknown> & {
  classification: EvidenceClassification;
  configuredAdapterMode: "auto" | "mock" | "ccs";
  configuredScriptingMode: "auto" | "mock" | "ccs";
  effectiveAdapterType: EffectiveAdapterType | null;
} {
  const launch = steps.find(step => step.stepType === "launchMulticore")?.output;
  const launchRecord = isRecord(launch) ? launch : undefined;
  // A full acceptance plan may intentionally keep preflight inside the
  // launch contract instead of adding a second durable step.  Treat that
  // embedded host-only result as equivalent evidence; never promote the
  // configured `auto` mode by itself.
  const preflight = steps.find(step => step.stepType === "preflight")?.output
    ?? (launchRecord && isRecord(launchRecord.preflight) ? launchRecord.preflight : undefined);
  const topology = launchRecord && isRecord(launchRecord.sessionTopology) ? launchRecord.sessionTopology : undefined;
  const sessionRecord = session && isRecord(session) ? session : undefined;
  const effectiveAdapterType = adapterTypeFrom(
    launchRecord?.effectiveAdapterType,
    topology?.effectiveAdapterType,
    topology?.adapterName,
    sessionRecord?.adapterSessionId,
    config.adapter === "mock" || config.ccs.scriptingMode === "mock" ? "mock" : undefined
  );
  const adapterSessionId = stringOrNull(launchRecord?.adapterSessionId)
    ?? stringOrNull(topology?.adapterSessionId)
    ?? stringOrNull(sessionRecord?.adapterSessionId);
  const sessionId = stringOrNull(launchRecord?.sessionId) ?? stringOrNull(sessionRecord?.sessionId);
  const physicalPreflight = physicalPreflightEvidence(preflight, probeSerial);
  const sessionEvidence = {
    present: Boolean(sessionId && adapterSessionId),
    sessionId,
    adapterSessionId,
    effectiveAdapterType
  };
  const classification: EvidenceClassification = effectiveAdapterType === "mock"
    ? "MOCK"
    : effectiveAdapterType === "ccs" && sessionEvidence.present && physicalPreflight.matched
      ? "HARDWARE_TARGET"
      : "UNKNOWN";
  return {
    boardId,
    configuredAdapterMode: config.adapter,
    configuredScriptingMode: config.ccs.scriptingMode,
    effectiveAdapterType,
    classification,
    physicalPreflight,
    sessionEvidence,
    provenance: {
      actualAdapterSource: launchRecord?.effectiveAdapterType ? "worker-response" : topology?.effectiveAdapterType ? "session-topology" : sessionRecord?.adapterSessionId ? "persisted-session" : "unavailable",
      configuredModeIsNotPromoted: true,
      classificationRequires: ["effectiveAdapterType", "adapterSessionId", "physicalXds110PreflightSerial"]
    }
  };
}

function physicalPreflightEvidence(output: unknown, probeSerial: string): Record<string, unknown> & { matched: boolean } {
  const value = isRecord(output) ? output : {};
  const xdsdfu = isRecord(value.xdsdfu) ? value.xdsdfu : {};
  const devices = Array.isArray(xdsdfu.devices) ? xdsdfu.devices.filter(isRecord) : [];
  const matching = devices.find(device => device.serialNumber === probeSerial);
  const matched = xdsdfu.probeReady === true && Boolean(matching);
  return {
    source: "c2000_getHardwarePreflight.xdsdfu",
    requestedProbeSerial: probeSerial,
    probeReady: xdsdfu.probeReady === true,
    matched,
    matchedDevice: matching ? {
      serialNumber: matching.serialNumber,
      name: matching.name,
      configuration: matching.configuration,
      mode: matching.mode,
      version: matching.version
    } : null,
    observedSerials: devices.map(device => device.serialNumber).filter((serial): serial is string => typeof serial === "string")
  };
}

function adapterTypeFrom(...values: unknown[]): EffectiveAdapterType | null {
  for (const value of values) {
    if (value === "ccs" || value === "ccs-scripting") return "ccs";
    if (value === "mock") return "mock";
    if (typeof value === "string" && value.startsWith("ccs-")) return "ccs";
    if (typeof value === "string" && value.startsWith("mock-")) return "mock";
  }
  return null;
}

function combineEvidenceClassification(values: EvidenceClassification[]): EvidenceClassification {
  if (values.length === 0) return "UNKNOWN";
  if (values.every(value => value === "MOCK")) return "MOCK";
  if (values.every(value => value === "HARDWARE_TARGET")) return "HARDWARE_TARGET";
  return values.some(value => value === "UNKNOWN") ? "UNKNOWN" : "MIXED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

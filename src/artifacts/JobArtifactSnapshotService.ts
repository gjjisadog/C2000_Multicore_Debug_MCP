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
      const previousManifest = await readJsonRecord(previousManifestPath);
      if (Array.isArray(previousManifest?.generatedFiles)) {
        snapshot.manifest.generatedFiles = previousManifest.generatedFiles.flatMap(value => {
          const parsed = artifactManifestSchema.shape.generatedFiles.unwrap().element.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
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
    const adapterType = this.adapterType;
    const evidenceClassification = adapterType === "mock" ? "MOCK" : adapterType === "ccs" ? "HARDWARE_TARGET" : "UNKNOWN";
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
      targets: targetContext.map(({ board, session, worker, cores, programs }) => ({
        boardId: board.boardId,
        boardProfile: { device: board.device, tags: [...board.tags].sort() },
        xds110Serial: board.probeSerial,
        adapterType,
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
        adapterType
      },
      startedAt: run.startedAt ?? run.submittedAt,
      endedAt: run.finishedAt ?? run.submittedAt,
      evidenceLevel: evidenceClassification,
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
    for (const fileName of ["manifest.json", "result.json", "events.jsonl", "target-state.jsonl", "summary.md"]) {
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

  private get adapterType(): "mock" | "ccs" | "auto" {
    return this.options.config.adapter === "auto" ? this.options.config.ccs.scriptingMode : this.options.config.adapter;
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
    "launchMulticore", "assignExpressions", "injectFaults", "captureExpressions", "waitForExpressions",
    "runCores", "haltCores", "reconnectAfterTargetReset", "restorePrograms", "resetReconnectCapture", "delay"
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
  return `# Test evidence summary

- Job: ${manifest.jobId}
- Type: ${manifest.jobType}
- Status: ${result.overallStatus}
- Evidence: ${result.evidenceClassification}
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

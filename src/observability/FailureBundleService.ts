import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import type { ArtifactExportRepository } from "../storage/repositories/ArtifactExportRepository.js";
import type { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import type { EventRepository } from "../storage/repositories/EventRepository.js";
import type { SessionRepository } from "../storage/repositories/SessionRepository.js";
import type { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import { sanitizeEvidence } from "./SensitiveDataFilter.js";
import { TraceService } from "./TraceService.js";
import {
  collectFailureBundleSchema,
  FAILURE_BUNDLE_SCHEMA_VERSION,
  type CollectFailureBundleInput
} from "./TraceSchemas.js";

type ItemStatus = "COLLECTED" | "MISSING" | "FAILED" | "CANCELLED" | "TIMED_OUT";

interface BundleItem {
  name: string;
  status: ItemStatus;
  path?: string;
  error?: string;
}

export class FailureBundleService {
  private readonly writer: AtomicArtifactWriter;

  constructor(private readonly options: {
    rootDirectory: string;
    runs: TestRunRepository;
    sessions: SessionRepository;
    events: EventRepository;
    artifacts: ArtifactRepository;
    exports: ArtifactExportRepository;
    canResults: CanTestResultRepository;
    trace: TraceService;
    writer?: AtomicArtifactWriter;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async collect(input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = collectFailureBundleSchema.parse(input);
    return this.collectParsed(parsed, signal);
  }

  async collectForJob(jobId: string, reason?: string): Promise<void> {
    await this.collect({ jobId, ...(reason ? { reason } : {}) });
  }

  private async collectParsed(input: CollectFailureBundleInput, parentSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const run = this.options.runs.get(input.jobId);
    if (!run) throw new Error(`Test run not found: ${input.jobId}`);
    const directory = path.join(this.jobDirectory(input.jobId), "failure-bundle");
    await this.writer.ensureDirectory(directory);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Failure bundle total timeout", "TimeoutError")), input.totalTimeoutMs);
    timer.unref();
    const onAbort = () => controller.abort(parentSignal?.reason ?? new DOMException("Failure bundle cancelled", "AbortError"));
    if (parentSignal?.aborted) onAbort();
    else parentSignal?.addEventListener("abort", onAbort, { once: true });
    const items: BundleItem[] = [];
    try {
      const recentEvents = this.recentEvents(input.jobId, run.submittedAt, run.finishedAt, input.recentEventLimit);
      await this.capture(items, "recent-events", "recent-events.jsonl", directory, input.itemTimeoutMs, controller.signal, async () => recentEvents);

      const boards = this.options.runs.boards(input.jobId);
      const sessions = boards.flatMap(board => board.sessionId ? [this.options.sessions.get(board.sessionId)].filter(Boolean) : []);
      await this.capture(items, "session-state", "session-state.json", directory, input.itemTimeoutMs, controller.signal, async () => ({
        available: sessions.length > 0,
        sessions
      }));
      await this.capture(items, "target-state", "target-state.json", directory, input.itemTimeoutMs, controller.signal, async () => ({
        available: sessions.some(session => session?.lastSnapshot),
        snapshots: sessions.flatMap(session => session?.lastSnapshot ? [{
          boardId: session.boardId,
          sessionId: session.sessionId,
          adapterSessionId: session.adapterSessionId ?? null,
          snapshot: session.lastSnapshot
        }] : [])
      }));

      const can = this.options.canResults.list(input.jobId);
      await this.capture(items, "can-evidence", "can-evidence.json", directory, input.itemTimeoutMs, controller.signal, async () => ({
        available: can.length > 0,
        results: can
      }));
      await this.captureArtifactSummary(items, input.jobId, directory, "variables", "variables.jsonl", "variables.json", input.itemTimeoutMs, controller.signal);
      await this.captureArtifactJson(items, input.jobId, directory, "erad", "erad.json", "erad.json", input.itemTimeoutMs, controller.signal);
      await this.captureArtifactJson(items, input.jobId, directory, "dlog", "dlog.json", path.join("dlog", "dlog.json"), input.itemTimeoutMs, controller.signal);

      if (input.includeTrace) {
        await this.capture(items, "trace", "trace.json", directory, input.itemTimeoutMs, controller.signal, async () =>
          this.options.trace.build({
            jobId: input.jobId,
            include: ["job-events", "lease-events", "worker-events", "dss-events", "target-state", "can-evidence", "variables", "erad", "dlog"],
            format: "perfetto",
            source: "auto"
          })
        );
      }

      const failure = sanitizeEvidence({
        schemaVersion: FAILURE_BUNDLE_SCHEMA_VERSION,
        jobId: input.jobId,
        status: run.status,
        reason: input.reason ?? inferFailureReason(run.error, recentEvents),
        error: run.error ?? null,
        cancelled: run.status === "CANCELLED" || run.cancelRequested,
        timedOut: hasTimeout(run.error),
        collectedAt: run.finishedAt ?? run.submittedAt
      });
      await this.writer.writeJson(path.join(directory, "failure.json"), failure);
      items.push({ name: "failure", status: "COLLECTED", path: "failure.json" });

      const completeness = items.every(item => item.status === "COLLECTED") ? "COMPLETE" : "INCOMPLETE";
      const manifest = sanitizeEvidence({
        schemaVersion: FAILURE_BUNDLE_SCHEMA_VERSION,
        jobId: input.jobId,
        createdAt: run.finishedAt ?? run.submittedAt,
        mode: "READ_ONLY_HISTORICAL",
        targetAccessAttempted: false,
        completeness,
        items
      });
      await this.writer.writeText(path.join(directory, "summary.md"), renderSummary(input.jobId, run.status, completeness, items));
      await this.writer.writeJson(path.join(directory, "manifest.json"), manifest);
      const manifestPath = path.join(directory, "manifest.json");
      const info = await stat(manifestPath);
      const sha256 = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
      this.options.artifacts.upsert({
        jobId: input.jobId,
        artifactType: "failure-bundle:manifest",
        path: manifestPath,
        sha256,
        size: info.size,
        createdAt: run.finishedAt ?? run.submittedAt
      });
      return {
        jobId: input.jobId,
        bundleDirectory: directory,
        manifestPath,
        completeness,
        items,
        targetAccessAttempted: false
      };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
    }
  }

  private async capture(
    items: BundleItem[],
    name: string,
    relativePath: string,
    directory: string,
    timeoutMs: number,
    signal: AbortSignal,
    collect: () => Promise<unknown>
  ): Promise<void> {
    try {
      // Do not construct a collector promise after cancellation. Some
      // collectors immediately enter SQLite; returning before attaching a
      // rejection handler would let that work outlive the bundle and race
      // repository shutdown.
      if (signal.aborted) throw signal.reason;
      const value = await withTimeout(collect(), timeoutMs, signal);
      if (isUnavailable(value)) {
        items.push({ name, status: "MISSING" });
        return;
      }
      const target = path.join(directory, relativePath);
      if (relativePath.endsWith(".jsonl") && Array.isArray(value)) {
        if (value.length === 0) {
          items.push({ name, status: "MISSING" });
          return;
        }
        await this.writer.writeJsonLines(target, sanitizeEvidence(value));
      } else {
        await this.writer.writeJson(target, sanitizeEvidence(value));
      }
      items.push({ name, status: "COLLECTED", path: relativePath.replaceAll("\\", "/") });
    } catch (error) {
      items.push({
        name,
        status: signal.aborted ? (isTimeout(signal.reason) ? "TIMED_OUT" : "CANCELLED") : isTimeout(error) ? "TIMED_OUT" : "FAILED",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private recentEvents(jobId: string, startedAt: string, finishedAt: string | undefined, limit: number) {
    const lower = Date.parse(startedAt);
    const upper = finishedAt ? Date.parse(finishedAt) : Number.POSITIVE_INFINITY;
    const values = [
      ...this.options.events.list({ jobId, limit: 1_000_000, ascending: true }),
      ...this.options.runs.boards(jobId).flatMap(board =>
        this.options.events.list({ boardId: board.boardId, limit: 1_000_000, ascending: true })
          .filter(event => {
            const timestamp = Date.parse(event.timestamp);
            return event.jobId === jobId || (!event.jobId && timestamp >= lower && timestamp <= upper);
          })
      )
    ];
    const seen = new Set<string>();
    return values.filter(event => {
      const key = event.eventId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => compareMonotonic(left.monotonicTimestampNs, right.monotonicTimestampNs))
      .slice(-limit);
  }

  private async captureArtifactSummary(
    items: BundleItem[],
    jobId: string,
    directory: string,
    name: string,
    sourceName: string,
    targetName: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    await this.capture(items, name, targetName, directory, timeoutMs, signal, async () => {
      const source = await this.findArtifact(jobId, sourceName);
      if (!source) return { available: false };
      const text = await readFile(source, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      const samples = lines.flatMap(line => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      });
      return {
        available: samples.length > 0,
        sourceCompleteness: text.endsWith("\n") ? "COMPLETE" : "INCOMPLETE",
        sampleCount: samples.length,
        firstSample: samples[0] ?? null,
        lastSample: samples.at(-1) ?? null
      };
    });
  }

  private async captureArtifactJson(
    items: BundleItem[],
    jobId: string,
    directory: string,
    name: string,
    sourceName: string,
    targetName: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    await this.capture(items, name, targetName, directory, timeoutMs, signal, async () => {
      const source = await this.findArtifact(jobId, sourceName);
      if (!source) return { available: false };
      return JSON.parse(await readFile(source, "utf8")) as unknown;
    });
  }

  private async findArtifact(jobId: string, fileName: string): Promise<string | undefined> {
    const candidates = [
      path.join(this.jobDirectory(jobId), fileName),
      ...this.options.artifacts.list(jobId).map(record => record.path).filter(candidate => path.basename(candidate).toLowerCase() === fileName)
    ];
    for (const candidate of candidates) {
      try { await stat(candidate); return candidate; } catch { /* absent */ }
    }
    return undefined;
  }

  private jobDirectory(jobId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error("Unsafe jobId for failure bundle path");
    return this.options.exports.get(jobId)?.rootPath ?? path.join(path.resolve(this.options.rootDirectory), jobId);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException("Failure bundle item timeout", "TimeoutError")), timeoutMs);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function isUnavailable(value: unknown): boolean {
  return isRecord(value) && value.available === false;
}

function inferFailureReason(error: Record<string, unknown> | undefined, events: Array<{ eventType: string }>): string {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code) return code;
  return events.at(-1)?.eventType ?? "JOB_TERMINAL_FAILURE";
}

function hasTimeout(error: Record<string, unknown> | undefined): boolean {
  return Boolean(error && JSON.stringify(error).toLowerCase().includes("timeout"));
}

function isTimeout(value: unknown): boolean {
  return value instanceof DOMException ? value.name === "TimeoutError" : value instanceof Error && /timeout/i.test(value.message);
}

function renderSummary(jobId: string, status: string, completeness: string, items: BundleItem[]): string {
  return `# Failure evidence bundle

- Job: ${jobId}
- Original job status: ${status}
- Bundle completeness: ${completeness}
- Collection mode: read-only historical evidence
- Target access attempted: no

## Evidence items

${items.map(item => `- ${item.name}: ${item.status}${item.error ? ` (${item.error})` : ""}`).join("\n")}

This summary is generated from manifest.json and failure.json. Missing and failed collectors do not alter the original job result.
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareMonotonic(left: string | undefined, right: string | undefined): number {
  if (left && right && /^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

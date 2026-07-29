import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import type { ArtifactExportRepository } from "../storage/repositories/ArtifactExportRepository.js";
import type { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import type { EventRepository, PersistedEvent } from "../storage/repositories/EventRepository.js";
import type { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import { DebugMcpError } from "../utils/errors.js";
import { sanitizeEvidence } from "./SensitiveDataFilter.js";
import {
  exportTraceSchema,
  TRACE_SCHEMA_VERSION,
  traceDocumentSchema,
  type ExportTraceInput,
  type PerfettoTraceEvent,
  type TraceDocument
} from "./TraceSchemas.js";

const TRACKS = [
  ["daemon-job", "Daemon / Job", 1, 1, "host-monotonic"],
  ["scheduler", "Scheduler", 1, 2, "host-monotonic"],
  ["board-permit", "Board Permit", 1, 3, "host-monotonic"],
  ["lease", "Lease", 1, 4, "host-monotonic"],
  ["board-worker", "Board Worker", 1, 5, "host-monotonic"],
  ["cpu1-debug", "CPU1 Debug", 1, 6, "host-monotonic"],
  ["cpu2-debug", "CPU2 Debug", 1, 7, "host-monotonic"],
  ["can-worker", "CAN Worker", 1, 8, "host-monotonic"],
  ["firmware-can-tx", "Firmware CAN TX", 2, 1, "mcu-counter"],
  ["pcan-bus-host", "PCAN Bus Evidence / Host Timestamp", 3, 1, "pcan-host"],
  ["pcan-bus-hardware", "PCAN Bus Evidence / Hardware Timestamp", 3, 2, "pcan-hardware"],
  ["firmware-can-rx", "Firmware CAN RX", 4, 1, "mcu-counter"],
  ["variables", "Variable Stream", 5, 1, "mcu-sample-index"],
  ["erad", "ERAD", 6, 1, "erad-cycle"],
  ["dlog", "DLOG", 7, 1, "dlog-relative"]
] as const;

const TIME_DOMAINS: TraceDocument["timeDomains"] = [
  { id: "host-monotonic", kind: "host-monotonic", unit: "microseconds-from-first-event", synchronizedToHost: true, calibration: null },
  { id: "host-wall-clock", kind: "host-wall-clock", unit: "ISO-8601", synchronizedToHost: false, calibration: null },
  { id: "pcan-host", kind: "pcan-host", unit: "source-defined", synchronizedToHost: false, calibration: null },
  { id: "pcan-hardware", kind: "pcan-hardware", unit: "source-defined", synchronizedToHost: false, calibration: null },
  { id: "mcu-counter", kind: "mcu-counter", unit: "counter", synchronizedToHost: false, calibration: null },
  { id: "mcu-sample-index", kind: "mcu-sample-index", unit: "sample-index", synchronizedToHost: false, calibration: null },
  { id: "erad-cycle", kind: "erad-cycle", unit: "cycle", synchronizedToHost: false, calibration: null },
  { id: "dlog-relative", kind: "dlog-relative", unit: "relative-microseconds", synchronizedToHost: false, calibration: null }
];

export class TraceService {
  private readonly writer: AtomicArtifactWriter;

  constructor(private readonly options: {
    rootDirectory: string;
    runs: TestRunRepository;
    events: EventRepository;
    artifacts: ArtifactRepository;
    exports: ArtifactExportRepository;
    canResults: CanTestResultRepository;
    writer?: AtomicArtifactWriter;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async export(input: unknown): Promise<Record<string, unknown>> {
    const parsed = exportTraceSchema.parse(input);
    const document = await this.build(parsed);
    const directory = this.jobDirectory(parsed.jobId);
    const tracePath = path.join(directory, "trace.json");
    await this.writer.writeJson(tracePath, document);
    const info = await stat(tracePath);
    const hash = createHash("sha256").update(await readFile(tracePath)).digest("hex");
    this.options.artifacts.upsert({
      jobId: parsed.jobId,
      artifactType: "observability:trace",
      path: tracePath,
      sha256: hash,
      size: info.size,
      createdAt: this.options.runs.get(parsed.jobId)?.finishedAt ?? this.options.runs.get(parsed.jobId)?.submittedAt
    });
    await this.updateManifest(parsed.jobId, {
      path: "trace.json",
      artifactType: "observability:trace",
      sha256: hash,
      size: info.size,
      completeness: document.completeness
    });
    return {
      jobId: parsed.jobId,
      tracePath,
      sha256: hash,
      size: info.size,
      completeness: document.completeness,
      generatedFrom: document.generatedFrom,
      eventCount: document.traceEvents.length,
      missingSources: document.missingSources,
      incompleteSources: document.incompleteSources
    };
  }

  async build(input: ExportTraceInput): Promise<TraceDocument> {
    const run = this.options.runs.get(input.jobId);
    const directory = this.jobDirectory(input.jobId);
    if (!run && !await this.writer.exists(path.join(directory, "manifest.json"))) {
      throw new DebugMcpError("EvidenceCaptureFailed", `No SQLite job or artifact snapshot exists for ${input.jobId}`, { jobId: input.jobId, evidenceType: "trace" });
    }
    const generatedFrom = new Set<"sqlite" | "artifacts">();
    const missing = new Set<string>();
    const incomplete = new Set<string>();
    const events: PerfettoTraceEvent[] = [];
    if (input.source !== "sqlite") {
      const manifest = await readJson(path.join(directory, "manifest.json"));
      if (isRecord(manifest) && isRecord(manifest.completeness) && manifest.completeness.status !== "COMPLETE") {
        incomplete.add("manifest.json");
      }
    }
    const sqliteEvents = input.source !== "artifacts" && run
      ? this.sqliteEventsForJob(input.jobId, run.submittedAt, run.finishedAt)
      : [];
    if (sqliteEvents.length > 0) {
      generatedFrom.add("sqlite");
      events.push(...hostEvents(sqliteEvents, input.include));
    } else if (input.include.some(item => ["job-events", "lease-events", "worker-events", "dss-events"].includes(item))) {
      const artifactEvents = await readJsonLines(path.join(directory, "events.jsonl"));
      if (artifactEvents.values.length > 0) {
        generatedFrom.add("artifacts");
        events.push(...hostEvents(artifactEvents.values.map(toPersistedEvent), input.include));
        if (!artifactEvents.complete) incomplete.add("events.jsonl");
      } else {
        missing.add("events.jsonl");
      }
    }

    if (input.include.includes("target-state")) {
      const targetStates = await readJsonLines(path.join(directory, "target-state.jsonl"));
      if (targetStates.values.length > 0) {
        generatedFrom.add("artifacts");
        events.push(...targetStateEvents(targetStates.values));
        if (!targetStates.complete) incomplete.add("target-state.jsonl");
      } else {
        missing.add("target-state");
      }
    }

    if (input.include.includes("can-evidence")) {
      const results = input.source !== "artifacts" && run ? this.options.canResults.list(input.jobId) : [];
      if (results.length > 0) {
        generatedFrom.add("sqlite");
        events.push(...canEvidenceEvents(results));
      } else {
        const canFile = await firstExisting(directory, ["can-frames.jsonl", "can-evidence.jsonl", "can-evidence.json"]);
        if (canFile) {
          generatedFrom.add("artifacts");
          const json = canFile.endsWith(".jsonl") ? undefined : await readJson(canFile);
          const parsed = canFile.endsWith(".jsonl")
            ? await readJsonLines(canFile)
            : { values: json === null ? [] : [json], complete: json !== null };
          events.push(...canEvidenceEvents(parsed.values.filter(isRecord).map((details, index) => ({
            resultId: `artifact-can-${index + 1}`, jobId: input.jobId, groupId: "artifact", phase: stringValue(details.phase) ?? "evidence",
            status: "INFO" as const, details, createdAt: stringValue(details.timestamp) ?? run?.finishedAt ?? run?.submittedAt ?? new Date(0).toISOString()
          }))));
          if (!parsed.complete) incomplete.add(path.basename(canFile));
        } else {
          missing.add("can-evidence");
        }
      }
    }

    await this.addOptionalSource(directory, input, "variables", "variables.jsonl", events, missing, incomplete, generatedFrom);
    await this.addOptionalSource(directory, input, "erad", "erad.json", events, missing, incomplete, generatedFrom);
    await this.addOptionalSource(directory, input, "dlog", "dlog.json", events, missing, incomplete, generatedFrom);

    if (generatedFrom.size === 0) generatedFrom.add(input.source === "artifacts" ? "artifacts" : "sqlite");
    const sorted = sortTraceEvents(events);
    const document: TraceDocument = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      format: "perfetto-trace-event-json",
      displayTimeUnit: "ms",
      jobId: input.jobId,
      generatedFrom: [...generatedFrom],
      primaryTimeDomain: "host-monotonic",
      timeDomains: TIME_DOMAINS,
      tracks: TRACKS.map(([id, name, pid, tid, timeDomain]) => ({ id, name, pid, tid, timeDomain })),
      traceEvents: [...metadataEvents(), ...sorted],
      missingSources: [...missing].sort(),
      incompleteSources: [...incomplete].sort(),
      completeness: incomplete.size > 0 || missing.size > 0 ? "INCOMPLETE" : "COMPLETE"
    };
    return traceDocumentSchema.parse(sanitizeEvidence(document));
  }

  private async addOptionalSource(
    directory: string,
    input: ExportTraceInput,
    include: "variables" | "erad" | "dlog",
    fileName: string,
    output: PerfettoTraceEvent[],
    missing: Set<string>,
    incomplete: Set<string>,
    generatedFrom: Set<"sqlite" | "artifacts">
  ): Promise<void> {
    if (!input.include.includes(include)) return;
    const file = await this.findArtifactFile(input.jobId, directory, fileName);
    if (!file) {
      missing.add(include);
      return;
    }
    generatedFrom.add("artifacts");
    if (fileName.endsWith(".jsonl")) {
      const parsed = await readJsonLines(file);
      output.push(...variableEvents(parsed.values));
      if (!parsed.complete) incomplete.add(fileName);
      return;
    }
    const value = await readJson(file);
    if (!isRecord(value)) {
      incomplete.add(fileName);
      return;
    }
    output.push(...(include === "erad" ? eradEvents(value) : dlogEvents(value)));
    const completeness = stringValue(value.completeness) ?? stringValue(value.captureCompleteness);
    if (completeness === "INCOMPLETE") incomplete.add(fileName);
  }

  private sqliteEventsForJob(jobId: string, startedAt: string, finishedAt?: string): PersistedEvent[] {
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
    });
  }

  private async findArtifactFile(jobId: string, directory: string, fileName: string): Promise<string | undefined> {
    const candidates = [
      path.join(directory, fileName),
      ...this.options.artifacts.list(jobId).map(record => record.path).filter(candidate => path.basename(candidate).toLowerCase() === fileName)
    ];
    for (const candidate of candidates) if (await this.writer.exists(candidate)) return candidate;
    return undefined;
  }

  private jobDirectory(jobId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new DebugMcpError("PathResolutionFailed", "Unsafe jobId for trace path", { jobId });
    return this.options.exports.get(jobId)?.rootPath ?? path.join(path.resolve(this.options.rootDirectory), jobId);
  }

  private async updateManifest(jobId: string, generated: Record<string, unknown>): Promise<void> {
    const manifestPath = path.join(this.jobDirectory(jobId), "manifest.json");
    if (!await this.writer.exists(manifestPath)) return;
    const manifest = await readJson(manifestPath);
    if (!isRecord(manifest)) return;
    const previous = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles.filter(isRecord) : [];
    const next = [...previous.filter(entry => entry.path !== generated.path), generated]
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));
    await this.writer.writeJson(manifestPath, { ...manifest, generatedFiles: next });
  }
}

function hostEvents(values: PersistedEvent[], include: ExportTraceInput["include"]): PerfettoTraceEvent[] {
  const filtered = values.filter(event => include.includes(classifyHostInclude(event)));
  const base = minimumBigInt(filtered.map(event => event.monotonicTimestampNs));
  return filtered.map((event, index) => {
    const track = classifyHostTrack(event);
    const coordinates = trackCoordinates(track);
    return {
      name: event.eventType,
      cat: track,
      ph: "i",
      s: "t",
      ts: relativeMicroseconds(event.monotonicTimestampNs, base, index),
      ...coordinates,
      args: sanitizeEvidence({
        timeDomain: "host-monotonic",
        sourceMonotonicTimestampNs: event.monotonicTimestampNs ?? null,
        wallClockTimestamp: event.timestamp ?? null,
        synchronizedAcrossDevices: false,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        jobId: event.jobId ?? null,
        boardId: event.boardId ?? null,
        workerGeneration: event.workerGeneration ?? null,
        ...event.payload
      })
    };
  });
}

function classifyHostInclude(event: PersistedEvent): ExportTraceInput["include"][number] {
  const text = `${event.sourceType} ${event.eventType}`.toLowerCase();
  if (text.includes("lease") || text.includes("permit")) return "lease-events";
  if (text.includes("worker")) return "worker-events";
  if (text.includes("dss") || text.includes("debug") || text.includes("core")) return "dss-events";
  return "job-events";
}

function classifyHostTrack(event: PersistedEvent): string {
  const text = `${event.sourceType} ${event.eventType}`.toLowerCase();
  const coreId = numberValue(event.payload.coreId);
  if (coreId === 0 || text.includes("cpu1")) return "cpu1-debug";
  if (coreId === 2 || text.includes("cpu2")) return "cpu2-debug";
  if (text.includes("permit")) return "board-permit";
  if (text.includes("lease")) return "lease";
  if (text.includes("scheduler") || text.includes("queued") || text.includes("retry")) return "scheduler";
  if (text.includes("can") && text.includes("worker")) return "can-worker";
  if (text.includes("worker")) return "board-worker";
  return "daemon-job";
}

function targetStateEvents(values: unknown[]): PerfettoTraceEvent[] {
  return values.filter(isRecord).flatMap((value, index) => {
    const cores = Array.isArray(value.cores) ? value.cores.filter(isRecord) : [];
    return cores.map((core, coreIndex) => {
      const coreId = numberValue(core.coreId);
      const track = coreId === 2 ? "cpu2-debug" : "cpu1-debug";
      return {
        name: "TARGET_STATE",
        cat: track,
        ph: "i" as const,
        s: "t" as const,
        ts: index * 1000 + coreIndex,
        ...trackCoordinates(track),
        args: sanitizeEvidence({ timeDomain: "host-wall-clock", wallClockTimestamp: value.timestamp ?? null, ...value, core })
      };
    });
  });
}

function variableEvents(values: unknown[]): PerfettoTraceEvent[] {
  return values.filter(isRecord).map((sample, index) => ({
    name: "Variable sample",
    cat: "variables",
    ph: "i" as const,
    s: "t" as const,
    ts: numberValue(sample.sequence) ?? index + 1,
    ...trackCoordinates("variables"),
    args: sanitizeEvidence({
      timeDomain: "mcu-sample-index",
      synchronizedToHost: false,
      targetSampleTime: sample.targetSampleTime ?? null,
      hostMonotonicTimestampNs: sample.monotonicTimestampNs ?? null,
      hostWallClockTimestamp: sample.timestamp ?? null,
      sampleIndex: sample.sequence ?? index + 1,
      variables: sample.variables ?? {}
    })
  }));
}

function eradEvents(value: Record<string, unknown>): PerfettoTraceEvent[] {
  const duration = numberValue(value.maxCycles) ?? numberValue(value.totalCycles) ?? 0;
  return [{
    name: stringValue(value.profileName) ?? "ERAD profile",
    cat: "erad",
    ph: "X",
    ts: 0,
    dur: duration,
    ...trackCoordinates("erad"),
    args: sanitizeEvidence({ timeDomain: "erad-cycle", synchronizedToHost: false, ...value })
  }];
}

function dlogEvents(value: Record<string, unknown>): PerfettoTraceEvent[] {
  const indices = Array.isArray(value.sampleIndex) ? value.sampleIndex : [];
  const times = Array.isArray(value.relativeTimeSeconds) ? value.relativeTimeSeconds : [];
  const channels = Array.isArray(value.channels) ? value.channels.filter(isRecord) : [];
  return indices.map((sampleIndex, index) => ({
    name: "DLOG sample",
    cat: "dlog",
    ph: "i" as const,
    s: "t" as const,
    ts: Math.max(0, Number(times[index] ?? index) * 1_000_000),
    ...trackCoordinates("dlog"),
    args: sanitizeEvidence({
      timeDomain: "dlog-relative",
      synchronizedToHost: false,
      sampleIndex,
      relativeTimeSeconds: times[index] ?? null,
      configuredSampleRateHz: value.sampleRateHz ?? null,
      values: Object.fromEntries(channels.map(channel => [
        stringValue(channel.name) ?? "unnamed",
        Array.isArray(channel.values) ? channel.values[index] ?? null : null
      ]))
    })
  }));
}

function canEvidenceEvents(values: Array<{ resultId: string; phase: string; status: string; details: Record<string, unknown>; createdAt: string }>): PerfettoTraceEvent[] {
  return values.flatMap((result, index) => {
    const stage = canStage(result.phase, result.details);
    const hasHardwareTimestamp = result.details.hardwareTimestamp !== undefined;
    const track = stage === "firmware-tx"
      ? "firmware-can-tx"
      : stage === "firmware-rx"
        ? "firmware-can-rx"
        : hasHardwareTimestamp ? "pcan-bus-hardware" : "pcan-bus-host";
    const domain = stage === "bus" ? (hasHardwareTimestamp ? "pcan-hardware" : "pcan-host") : "mcu-counter";
    const sourceTime = firstNumber(result.details, ["hardwareTimestamp", "pcanTimestamp", "mcuCounter", "counter", "sequence"]) ?? index;
    return [{
      name: `CAN ${result.phase}`,
      cat: stage === "bus" ? "pcan-bus" : track,
      ph: "i" as const,
      s: "t" as const,
      ts: Math.max(0, sourceTime),
      ...trackCoordinates(track),
      args: sanitizeEvidence({
        timeDomain: domain,
        synchronizedToHost: false,
        wallClockTimestamp: result.createdAt,
        status: result.status,
        resultId: result.resultId,
        ...result.details
      })
    }];
  });
}

function canStage(phase: string, details: Record<string, unknown>): "firmware-tx" | "bus" | "firmware-rx" {
  const text = `${phase} ${details.stage ?? ""} ${details.source ?? ""}`.toLowerCase();
  if (text.includes("firmware") && text.includes("tx")) return "firmware-tx";
  if (text.includes("firmware") && text.includes("rx")) return "firmware-rx";
  return "bus";
}

function metadataEvents(): PerfettoTraceEvent[] {
  return TRACKS.map(([id, name, pid, tid, timeDomain]) => ({
    name: "thread_name",
    cat: "__metadata",
    ph: "M" as const,
    ts: 0,
    pid,
    tid,
    args: { name, trackId: id, timeDomain }
  }));
}

function sortTraceEvents(events: PerfettoTraceEvent[]): PerfettoTraceEvent[] {
  return [...events].sort((left, right) =>
    left.pid - right.pid || left.ts - right.ts || left.tid - right.tid || left.name.localeCompare(right.name)
  );
}

function trackCoordinates(id: string): { pid: number; tid: number } {
  const found = TRACKS.find(track => track[0] === id) ?? TRACKS[0];
  return { pid: found[2], tid: found[3] };
}

async function readJson(filePath: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function readJsonLines(filePath: string): Promise<{ values: unknown[]; complete: boolean }> {
  try {
    const text = await readFile(filePath, "utf8");
    const completeLine = text.length === 0 || text.endsWith("\n");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const values: unknown[] = [];
    let complete = completeLine;
    for (const line of lines) {
      try { values.push(JSON.parse(line)); } catch { complete = false; }
    }
    return { values, complete };
  } catch {
    return { values: [], complete: false };
  }
}

async function firstExisting(directory: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const candidate = path.join(directory, name);
    try { await stat(candidate); return candidate; } catch { /* absent */ }
  }
  return undefined;
}

function toPersistedEvent(value: unknown): PersistedEvent {
  const record = isRecord(value) ? value : {};
  const source = isRecord(record.source) ? record.source : {};
  return {
    level: "info",
    sourceType: stringValue(source.type) ?? "artifact",
    sourceId: stringValue(source.id) ?? "artifact",
    ...(stringValue(record.jobId) ? { jobId: stringValue(record.jobId)! } : {}),
    ...(stringValue(record.boardId) ? { boardId: stringValue(record.boardId)! } : {}),
    ...(numberValue(record.workerGeneration) ? { workerGeneration: numberValue(record.workerGeneration)! } : {}),
    ...(numberValue(record.sequence) ? { sequence: numberValue(record.sequence)! } : {}),
    ...(stringValue(record.monotonicTimestampNs) ? { monotonicTimestampNs: stringValue(record.monotonicTimestampNs)! } : {}),
    timestamp: stringValue(record.timestamp) ?? new Date(0).toISOString(),
    eventType: stringValue(record.eventType) ?? "ARTIFACT_EVENT",
    payload: isRecord(record.payload) ? record.payload : {}
  };
}

function minimumBigInt(values: Array<string | undefined>): bigint {
  const parsed = values.flatMap(value => value && /^\d+$/.test(value) ? [BigInt(value)] : []);
  return parsed.length ? parsed.reduce((left, right) => left < right ? left : right) : 0n;
}

function relativeMicroseconds(value: string | undefined, base: bigint, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  return Number((BigInt(value) - base) / 1000n);
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = numberValue(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import type { ArtifactExportRepository } from "../storage/repositories/ArtifactExportRepository.js";
import type { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import type { EventRepository } from "../storage/repositories/EventRepository.js";
import type { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import { sanitizeEvidence } from "../observability/SensitiveDataFilter.js";
import { DebugMcpError } from "../utils/errors.js";
import { deterministicStatistics } from "./DeterministicStatistics.js";
import {
  METRIC_SCHEMA_VERSION,
  runMetricsDocumentSchema,
  type RunMetric,
  type RunMetricsDocument
} from "./MetricSchemas.js";

type SourceKind = RunMetric["sources"][number]["kind"];
type Accumulator = {
  values: unknown[];
  unit: string;
  missCount: number;
  overflowCount: number;
  source: RunMetric["sources"][number];
};

export class RunMetricsService {
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

  async export(jobId: string): Promise<{ document: RunMetricsDocument; path: string; sha256: string }> {
    const document = await this.build(jobId);
    const directory = this.jobDirectory(jobId);
    const filePath = path.join(directory, "metrics.json");
    await this.writer.writeJson(filePath, sanitizeEvidence(document));
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.options.artifacts.upsert({
      jobId,
      artifactType: "observability:metrics",
      path: filePath,
      sha256,
      size: bytes.byteLength,
      createdAt: this.options.runs.get(jobId)?.finishedAt ?? new Date().toISOString()
    });
    await this.updateManifest(jobId, {
      path: "metrics.json", artifactType: "observability:metrics", sha256,
      size: bytes.byteLength, completeness: "COMPLETE"
    });
    return { document, path: filePath, sha256 };
  }

  async build(jobId: string): Promise<RunMetricsDocument> {
    const run = this.options.runs.get(jobId);
    const directory = this.jobDirectory(jobId);
    if (!run && !await this.writer.exists(path.join(directory, "manifest.json"))) {
      throw new DebugMcpError("EvidenceCaptureFailed", `No durable run evidence exists for ${jobId}`, { jobId });
    }
    const manifest = await readJson(path.join(directory, "manifest.json"));
    const evidenceLevel = evidenceFromManifest(manifest);
    const metrics = new Map<string, Accumulator>();
    const add = (name: string, values: readonly unknown[], kind: SourceKind, filePath: string, selector: string, unit = "", counters: Partial<Pick<Accumulator, "missCount" | "overflowCount">> = {}) => {
      if (values.length === 0 && !counters.missCount && !counters.overflowCount) return;
      const source = {
        kind,
        path: path.relative(directory, filePath).replaceAll("\\", "/"),
        sha256: null,
        selector,
        evidenceLevel
      } satisfies RunMetric["sources"][number];
      const current = metrics.get(name);
      if (current) {
        current.values.push(...values);
        current.missCount += counters.missCount ?? 0;
        current.overflowCount += counters.overflowCount ?? 0;
      } else {
        metrics.set(name, {
          values: [...values], unit,
          missCount: counters.missCount ?? 0,
          overflowCount: counters.overflowCount ?? 0,
          source
        });
      }
    };

    await this.readVariables(directory, add);
    await this.readDlog(directory, add);
    await this.readErad(directory, add);
    await this.readArtifactNumbers(directory, add);
    if (run) {
      for (const event of this.options.events.list({ jobId, limit: 100_000, ascending: true })) {
        collectNumericLeaves(event.payload, `events.${event.eventType}`, (name, values) =>
          add(name, values, "job-events", path.join(directory, "events.jsonl"), `event:${event.eventId}`));
      }
      for (const result of this.options.canResults.list(jobId)) {
        collectNumericLeaves(result.details, `can.${result.phase}`, (name, values) =>
          add(name, values, "can", path.join(directory, "can-evidence.json"), `result:${result.resultId}`));
      }
    }

    const result: RunMetricsDocument = {
      schemaVersion: METRIC_SCHEMA_VERSION,
      jobId,
      generatedAt: run?.finishedAt ?? run?.submittedAt ?? new Date().toISOString(),
      percentileMethod: "linear-r7",
      standardDeviation: "population",
      evidenceLevel,
      metrics: await Promise.all([...metrics.entries()].sort(([left], [right]) => left.localeCompare(right)).map(async ([name, value]) => {
        const rawSamples = value.values.filter((sample): sample is number => typeof sample === "number" && Number.isFinite(sample));
        return {
          name,
          unit: value.unit,
          statistics: deterministicStatistics(value.values, {
            missCount: value.missCount,
            overflowCount: value.overflowCount
          }),
          rawSamples,
          sources: [{
            ...value.source,
            sha256: await fileSha256(path.join(directory, value.source.path))
          }]
        };
      }))
    };
    return runMetricsDocumentSchema.parse(result);
  }

  private async readVariables(directory: string, add: AddMetric): Promise<void> {
    const filePath = path.join(directory, "variables.jsonl");
    const lines = await readJsonLines(filePath);
    for (const sample of lines) {
      if (!isRecord(sample) || !isRecord(sample.variables)) continue;
      for (const [symbol, reading] of Object.entries(sample.variables)) {
        if (!isRecord(reading)) continue;
        add(`variables.${symbol}`, [reading.status === "OK" ? reading.value : null], "variables", filePath, `sequence:${sample.sequence ?? "unknown"}`, "", {
          missCount: reading.status === "OK" ? 0 : 1
        });
      }
      if (typeof sample.actualHostIntervalMs === "number") {
        add("variables.actualHostIntervalMs", [sample.actualHostIntervalMs], "variables", filePath, `sequence:${sample.sequence ?? "unknown"}`, "ms");
      }
    }
  }

  private async readDlog(directory: string, add: AddMetric): Promise<void> {
    const filePath = path.join(directory, "dlog.json");
    const value = await readJson(filePath);
    if (!isRecord(value) || !Array.isArray(value.channels)) return;
    for (const channel of value.channels.filter(isRecord)) {
      if (typeof channel.name !== "string" || !Array.isArray(channel.values)) continue;
      add(`dlog.${channel.name}`, channel.values, "dlog", filePath, `channel:${channel.name}`, typeof channel.unit === "string" ? channel.unit : "");
      const valid = channel.values.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
      if (valid.length > 0) {
        const rms = Math.sqrt(valid.reduce((sum, item) => sum + item ** 2, 0) / valid.length);
        add(`dlog.${channel.name}.rms`, [rms], "dlog", filePath, `derived-rms:${channel.name}`, typeof channel.unit === "string" ? channel.unit : "");
      }
    }
  }

  private async readErad(directory: string, add: AddMetric): Promise<void> {
    const filePath = path.join(directory, "erad.json");
    const value = await readJson(filePath);
    if (!isRecord(value)) return;
    const prefix = `erad.${typeof value.profileName === "string" ? value.profileName : "profile"}`;
    const overflowCount = typeof value.overflowCount === "number" ? Math.max(0, Math.floor(value.overflowCount)) : 0;
    for (const field of ["count", "totalCycles", "minCycles", "maxCycles", "meanCycles", "overflowCount"] as const) {
      if (typeof value[field] === "number") {
        add(`${prefix}.${field}`, [value[field]], "erad", filePath, field, field.endsWith("Cycles") ? "cycles" : "", {
          overflowCount
        });
      }
    }
  }

  private async readArtifactNumbers(directory: string, add: AddMetric): Promise<void> {
    for (const file of ["can-evidence.json", "result.json"]) {
      const filePath = path.join(directory, file);
      const value = await readJson(filePath);
      if (!isRecord(value)) continue;
      collectNumericLeaves(value, `artifact.${file.replace(".json", "")}`, (name, values) =>
        add(name, values, file.startsWith("can") ? "can" : "artifact", filePath, "$"));
    }
  }

  private jobDirectory(jobId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new DebugMcpError("PathResolutionFailed", "Unsafe jobId", { jobId });
    return this.options.exports.get(jobId)?.rootPath ?? path.join(path.resolve(this.options.rootDirectory), jobId);
  }

  private async updateManifest(jobId: string, generated: Record<string, unknown>): Promise<void> {
    const manifestPath = path.join(this.jobDirectory(jobId), "manifest.json");
    const manifest = await readJson(manifestPath);
    if (!isRecord(manifest)) return;
    const previous = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles.filter(isRecord) : [];
    const next = [...previous.filter(entry => entry.path !== generated.path), generated]
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));
    await this.writer.writeJson(manifestPath, { ...manifest, generatedFiles: next });
  }
}

type AddMetric = (name: string, values: readonly unknown[], kind: SourceKind, filePath: string, selector: string, unit?: string, counters?: Partial<Pick<Accumulator, "missCount" | "overflowCount">>) => void;

function collectNumericLeaves(value: unknown, prefix: string, add: (name: string, values: unknown[]) => void): void {
  if (Array.isArray(value)) {
    const scalar = value.filter(item => typeof item === "number" || item === null);
    if (scalar.length > 0) add(prefix, scalar);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const name = `${prefix}.${key}`;
    if (typeof item === "number" || item === null) add(name, [item]);
    else collectNumericLeaves(item, name, add);
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

async function fileSha256(filePath: string): Promise<string | null> {
  try { return createHash("sha256").update(await readFile(filePath)).digest("hex"); } catch { return null; }
}

function evidenceFromManifest(value: unknown): RunMetricsDocument["evidenceLevel"] {
  return isRecord(value) && ["MOCK", "HARDWARE_TARGET", "HARDWARE_BUS", "MIXED", "UNKNOWN"].includes(String(value.evidenceLevel))
    ? value.evidenceLevel as RunMetricsDocument["evidenceLevel"]
    : "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

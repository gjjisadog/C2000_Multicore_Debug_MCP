import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import { SERVER_VERSION } from "../runtimeInfo.js";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import type { ArtifactExportRepository } from "../storage/repositories/ArtifactExportRepository.js";
import type { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import { DebugMcpError } from "../utils/errors.js";
import type { RunMetricsService } from "./RunMetricsService.js";
import {
  BASELINE_SCHEMA_VERSION,
  baselineComparisonSchema,
  compareRunWithBaselineSchema,
  createRunBaselineSchema,
  runBaselineSchema,
  type BaselineComparison,
  type BaselineRule,
  type RunBaseline,
  type RunMetric
} from "./MetricSchemas.js";

export class BaselineService {
  private readonly writer: AtomicArtifactWriter;

  constructor(private readonly options: {
    rootDirectory: string;
    runs: TestRunRepository;
    artifacts: ArtifactRepository;
    exports: ArtifactExportRepository;
    metrics: RunMetricsService;
    writer?: AtomicArtifactWriter;
  }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async create(input: unknown): Promise<Record<string, unknown>> {
    const parsed = createRunBaselineSchema.parse(input);
    const run = this.options.runs.get(parsed.jobId);
    if (!run) throw new DebugMcpError("EvidenceCaptureFailed", `Test run not found: ${parsed.jobId}`, { jobId: parsed.jobId });
    const metrics = await this.options.metrics.export(parsed.jobId);
    const manifest = await readJson(path.join(this.jobDirectory(parsed.jobId), "manifest.json"));
    const identity = buildIdentity(manifest, run.planName, run.planVersion, metrics.document.evidenceLevel);
    const baselineId = baselineIdFor(parsed.baselineName, parsed.jobId, identity.firmwareSha256);
    const baseline: RunBaseline = runBaselineSchema.parse({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      baselineId,
      baselineName: parsed.baselineName ?? null,
      createdAt: run.finishedAt ?? run.submittedAt,
      sourceJobId: parsed.jobId,
      sourceMetricsPath: portablePath(this.options.rootDirectory, metrics.path),
      sourceMetricsSha256: metrics.sha256,
      identity,
      rules: parsed.rules,
      metrics: metrics.document.metrics.map(({ rawSamples: _rawSamples, ...metric }) => metric)
    });
    const baselinePath = path.join(this.baselinesDirectory(), `${baselineId}.json`);
    await this.writer.writeJson(baselinePath, baseline);
    await this.register(parsed.jobId, "baseline:definition", baselinePath);
    return { baselineId, baselinePath, baseline, metricsPath: metrics.path };
  }

  async compare(input: unknown): Promise<Record<string, unknown>> {
    const parsed = compareRunWithBaselineSchema.parse(input);
    const baselinePath = path.join(this.baselinesDirectory(), `${safeId(parsed.baselineId)}.json`);
    const baselineValue = await readJson(baselinePath);
    if (!isRecord(baselineValue) || baselineValue.schemaVersion !== BASELINE_SCHEMA_VERSION) {
      throw new DebugMcpError("BaselineSchemaUnsupported", `Baseline ${parsed.baselineId} does not use schema version ${BASELINE_SCHEMA_VERSION}`, {
        baselineId: parsed.baselineId,
        schemaVersion: isRecord(baselineValue) ? baselineValue.schemaVersion : null
      });
    }
    const baseline = runBaselineSchema.parse(baselineValue);
    const run = this.options.runs.get(parsed.jobId);
    if (!run) throw new DebugMcpError("EvidenceCaptureFailed", `Test run not found: ${parsed.jobId}`, { jobId: parsed.jobId });
    const metrics = await this.options.metrics.export(parsed.jobId);
    const manifest = await readJson(path.join(this.jobDirectory(parsed.jobId), "manifest.json"));
    const identity = buildIdentity(manifest, run.planName, run.planVersion, metrics.document.evidenceLevel);
    const mismatches = identityMismatches(baseline.identity, identity);
    const compatibility = mismatches.length === 0
      ? { status: "EXACT" as const, mismatches, overrideRequested: parsed.allowCompatibleComparison }
      : parsed.allowCompatibleComparison
        ? { status: "OVERRIDDEN" as const, mismatches, overrideRequested: true }
        : { status: "INCOMPATIBLE" as const, mismatches, overrideRequested: false };
    const rules = parsed.rules ?? baseline.rules;
    const results = compatibility.status === "INCOMPATIBLE"
      ? []
      : rules.map(rule => evaluateRule(rule, baseline.metrics, metrics.document.metrics));
    const overallStatus: BaselineComparison["overallStatus"] = compatibility.status === "INCOMPATIBLE" || rules.length === 0
      ? "NOT_COMPARABLE"
      : results.some(result => result.status !== "PASSED") ? "FAILED" : "PASSED";
    const comparisonId = `comparison-${createHash("sha256").update(JSON.stringify({
      baselineId: baseline.baselineId,
      runJobId: parsed.jobId,
      rules,
      compatibility
    })).digest("hex").slice(0, 24)}`;
    const comparison: BaselineComparison = baselineComparisonSchema.parse({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      comparisonId,
      baselineId: baseline.baselineId,
      baselineSourceJobId: baseline.sourceJobId,
      runJobId: parsed.jobId,
      comparedAt: run.finishedAt ?? run.submittedAt,
      compatibility,
      overallStatus,
      results,
      baselinePath: portablePath(this.options.rootDirectory, baselinePath),
      runMetricsPath: portablePath(this.options.rootDirectory, metrics.path)
    });
    const comparisonPath = path.join(this.jobDirectory(parsed.jobId), `baseline-comparison-${safeId(baseline.baselineId)}.json`);
    await this.writer.writeJson(comparisonPath, comparison);
    await this.register(parsed.jobId, "baseline:comparison", comparisonPath);
    return { comparisonPath, comparison };
  }

  private baselinesDirectory(): string {
    return path.join(path.resolve(this.options.rootDirectory), "baselines");
  }

  private jobDirectory(jobId: string): string {
    safeId(jobId);
    return this.options.exports.get(jobId)?.rootPath ?? path.join(path.resolve(this.options.rootDirectory), jobId);
  }

  private async register(jobId: string, artifactType: string, filePath: string): Promise<void> {
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const size = (await stat(filePath)).size;
    this.options.artifacts.upsert({
      jobId, artifactType, path: filePath,
      sha256,
      size,
      createdAt: this.options.runs.get(jobId)?.finishedAt ?? new Date().toISOString()
    });
    const manifestPath = path.join(this.jobDirectory(jobId), "manifest.json");
    const manifest = await readJson(manifestPath);
    if (!isRecord(manifest)) return;
    const generated = {
      path: path.relative(this.jobDirectory(jobId), filePath).replaceAll("\\", "/"),
      artifactType,
      sha256,
      size,
      completeness: "COMPLETE"
    };
    const previous = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles.filter(isRecord) : [];
    const next = [...previous.filter(entry => entry.path !== generated.path), generated]
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));
    await this.writer.writeJson(manifestPath, { ...manifest, generatedFiles: next });
  }
}

function buildIdentity(manifest: unknown, planName: string, planVersion: number, evidenceLevel: RunBaseline["identity"]["evidenceLevel"]): RunBaseline["identity"] {
  if (!isRecord(manifest) || !Array.isArray(manifest.targets)) {
    throw new DebugMcpError("EvidenceCaptureFailed", "manifest.json is required to bind a baseline identity");
  }
  const targets = manifest.targets.filter(isRecord);
  const boardProfiles = targets.map(target => isRecord(target.boardProfile) ? {
    device: String(target.boardProfile.device ?? "unknown"),
    tags: Array.isArray(target.boardProfile.tags) ? target.boardProfile.tags.map(String).sort() : []
  } : { device: "unknown", tags: [] });
  const programs = targets.flatMap(target => Array.isArray(target.programs) ? target.programs.filter(isRecord) : []);
  const cpu1 = programs.filter(program => Number(program.coreId) === 0).map(program => program.outSha256).filter(isSha);
  const cpu2 = programs.filter(program => Number(program.coreId) === 2).map(program => program.outSha256).filter(isSha);
  const all = [...cpu1, ...cpu2].sort();
  if (all.length === 0) throw new DebugMcpError("EvidenceCaptureFailed", "Firmware SHA-256 is required to create or compare a baseline");
  return {
    device: [...new Set(boardProfiles.map(profile => profile.device))].sort(),
    boardProfiles,
    firmwareSha256: createHash("sha256").update(all.join("\n")).digest("hex"),
    cpu1OutSha256: cpu1.sort(),
    cpu2OutSha256: cpu2.sort(),
    testPlanId: planName,
    testPlanVersion: planVersion,
    metricSchemaVersion: 1,
    toolVersion: SERVER_VERSION,
    evidenceLevel
  };
}

function identityMismatches(left: RunBaseline["identity"], right: RunBaseline["identity"]): string[] {
  const checks: Array<[string, unknown, unknown]> = [
    ["firmwareSha256", left.firmwareSha256, right.firmwareSha256],
    ["cpu1OutSha256", left.cpu1OutSha256, right.cpu1OutSha256],
    ["cpu2OutSha256", left.cpu2OutSha256, right.cpu2OutSha256],
    ["testPlanId", left.testPlanId, right.testPlanId],
    ["testPlanVersion", left.testPlanVersion, right.testPlanVersion],
    ["device", left.device, right.device],
    ["boardProfiles", left.boardProfiles, right.boardProfiles],
    ["metricSchemaVersion", left.metricSchemaVersion, right.metricSchemaVersion]
  ];
  return checks.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b)).map(([name]) => name);
}

function evaluateRule(rule: BaselineRule, baseline: Omit<RunMetric, "rawSamples">[], actual: RunMetric[]) {
  const base = baseline.find(metric => metric.name === rule.metric);
  const run = actual.find(metric => metric.name === rule.metric);
  if (!base || !run) return { metric: rule.metric, rule: rule.rule, status: "MISSING" as const, baselineValue: null, actualValue: null, limit: null, message: "Metric is missing from baseline or run" };
  const statistic = rule.rule === "p95-upper-bound" ? "p95"
    : rule.rule === "p99-upper-bound" ? "p99"
      : rule.rule === "upper-bound" ? "max"
        : rule.rule === "lower-bound" ? "min"
          : "mean";
  const baselineValue = base.statistics[statistic];
  const actualValue = run.statistics[statistic];
  if (baselineValue === null || actualValue === null) return { metric: rule.metric, rule: rule.rule, status: "MISSING" as const, baselineValue, actualValue, limit: null, message: "Metric has no valid samples" };
  let passed = false;
  let limit: number;
  switch (rule.rule) {
    case "upper-bound": case "p95-upper-bound": case "p99-upper-bound":
      limit = rule.limit; passed = actualValue <= limit; break;
    case "lower-bound":
      limit = rule.limit; passed = actualValue >= limit; break;
    case "absolute-difference":
      limit = rule.limit; passed = Math.abs(actualValue - baselineValue) <= limit; break;
    case "relative-increase":
      limit = rule.limitPercent;
      passed = baselineValue === 0 ? actualValue <= 0 : ((actualValue - baselineValue) / Math.abs(baselineValue)) * 100 <= limit;
      break;
  }
  return {
    metric: rule.metric, rule: rule.rule, status: passed ? "PASSED" as const : "FAILED" as const,
    baselineValue, actualValue, limit,
    message: passed ? "Threshold satisfied" : "Threshold exceeded"
  };
}

function baselineIdFor(name: string | undefined, jobId: string, hash: string): string {
  const prefix = name ? safeId(name.replaceAll(" ", "-")) : "baseline";
  return `${prefix}-${safeId(jobId)}-${hash.slice(0, 12)}`;
}

function portablePath(rootDirectory: string, filePath: string): string {
  return path.relative(path.resolve(rootDirectory), path.resolve(filePath)).replaceAll("\\", "/");
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new DebugMcpError("PathResolutionFailed", "Unsafe baseline or job id", { value });
  return value;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function readJson(filePath: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaselineService } from "../src/analytics/BaselineService.js";
import { deterministicStatistics, percentileR7 } from "../src/analytics/DeterministicStatistics.js";
import { baselineComparisonSchema, runBaselineSchema, runMetricsDocumentSchema } from "../src/analytics/MetricSchemas.js";
import { RunMetricsService } from "../src/analytics/RunMetricsService.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { ArtifactExportRepository } from "../src/storage/repositories/ArtifactExportRepository.js";
import { ArtifactRepository } from "../src/storage/repositories/ArtifactRepository.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { CanTestResultRepository } from "../src/storage/repositories/CanTestResultRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("deterministic statistics", () => {
  it("computes count, extrema, percentiles and population deviation deterministically", () => {
    const result = deterministicStatistics([4, 1, 3, 2]);
    expect(result).toMatchObject({ count: 4, min: 1, max: 4, mean: 2.5, p50: 2.5 });
    expect(result.p95).toBeCloseTo(3.85);
    expect(result.p99).toBeCloseTo(3.97);
    expect(result.stddev).toBeCloseTo(Math.sqrt(1.25));
    expect(percentileR7([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85);
  });

  it("counts invalid, missed and overflow samples without contaminating statistics", () => {
    expect(deterministicStatistics([1, null, Number.NaN, 3], { missCount: 2, overflowCount: 4 }))
      .toMatchObject({ count: 2, mean: 2, invalidCount: 2, missCount: 2, overflowCount: 4 });
  });
});

describe("run metrics and baselines", () => {
  it("preserves raw variable and DLOG measurements with source references", async () => {
    const fixture = await createFixture();
    const exported = await fixture.metrics.export(fixture.jobA);
    const document = runMetricsDocumentSchema.parse(exported.document);
    expect(document.metrics.find(metric => metric.name === "variables.g_value")?.rawSamples).toEqual([10, 12, 14]);
    expect(document.metrics.find(metric => metric.name === "dlog.ia")?.statistics.max).toBe(4);
    expect(document.metrics.find(metric => metric.name === "dlog.ia.rms")?.rawSamples[0]).toBeCloseTo(Math.sqrt(7.5));
    expect(document.metrics.every(metric => metric.sources.length > 0)).toBe(true);
    fixture.store.close();
  });

  it("creates an identity-bound baseline linked to the source metrics artifact", async () => {
    const fixture = await createFixture();
    const result = await fixture.baselines.create({
      jobId: fixture.jobA,
      baselineName: "release",
      rules: [{ metric: "variables.g_value", rule: "relative-increase", limitPercent: 10 }]
    });
    const baseline = runBaselineSchema.parse(result.baseline);
    expect(baseline.identity).toMatchObject({
      device: ["F28P65x"],
      testPlanId: "plan-a",
      testPlanVersion: 1,
      evidenceLevel: "MOCK"
    });
    expect(baseline.sourceMetricsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.metrics[0]).not.toHaveProperty("rawSamples");
    const manifest = JSON.parse(await readFile(path.join(fixture.root, fixture.jobA, "manifest.json"), "utf8"));
    expect(manifest.generatedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactType: "baseline:definition", completeness: "COMPLETE" })
    ]));
    fixture.store.close();
  });

  it("fails closed on firmware and test-plan identity mismatch", async () => {
    const fixture = await createFixture();
    const created = await fixture.baselines.create({ jobId: fixture.jobA });
    const result = await fixture.baselines.compare({ jobId: fixture.jobB, baselineId: created.baselineId });
    const comparison = baselineComparisonSchema.parse(result.comparison);
    expect(comparison.overallStatus).toBe("NOT_COMPARABLE");
    expect(comparison.compatibility.mismatches).toEqual(expect.arrayContaining(["firmwareSha256", "testPlanId"]));
    fixture.store.close();
  });

  it("marks explicitly overridden compatibility and applies a relative threshold", async () => {
    const fixture = await createFixture();
    const created = await fixture.baselines.create({ jobId: fixture.jobA });
    const result = await fixture.baselines.compare({
      jobId: fixture.jobB,
      baselineId: created.baselineId,
      allowCompatibleComparison: true,
      rules: [{ metric: "variables.g_value", rule: "relative-increase", limitPercent: 5 }]
    });
    const comparison = baselineComparisonSchema.parse(result.comparison);
    expect(comparison.compatibility.status).toBe("OVERRIDDEN");
    expect(comparison.overallStatus).toBe("FAILED");
    expect(comparison.results[0]).toMatchObject({ status: "FAILED", baselineValue: 12, actualValue: 22 });
    fixture.store.close();
  });

  it("rejects old baseline schemas instead of silently upgrading them", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.root, "baselines"), { recursive: true });
    await writeFile(path.join(fixture.root, "baselines", "old.json"), JSON.stringify({ schemaVersion: 0, baselineId: "old" }));
    await expect(fixture.baselines.compare({ jobId: fixture.jobA, baselineId: "old" })).rejects.toThrow();
    fixture.store.close();
  });

  it("does not change the original run verdict during export or comparison", async () => {
    const fixture = await createFixture();
    const created = await fixture.baselines.create({ jobId: fixture.jobA });
    await fixture.baselines.compare({ jobId: fixture.jobA, baselineId: created.baselineId });
    expect(fixture.runs.get(fixture.jobA)?.status).toBe("PASSED");
    fixture.store.close();
  });

  it("writes byte-idempotent portable comparison artifacts", async () => {
    const fixture = await createFixture();
    const created = await fixture.baselines.create({
      jobId: fixture.jobA,
      rules: [{ metric: "variables.g_value", rule: "upper-bound", limit: 20 }]
    });
    const first = await fixture.baselines.compare({ jobId: fixture.jobA, baselineId: created.baselineId });
    const before = await readFile(first.comparisonPath as string, "utf8");
    const second = await fixture.baselines.compare({ jobId: fixture.jobA, baselineId: created.baselineId });
    expect(await readFile(second.comparisonPath as string, "utf8")).toBe(before);
    const document = baselineComparisonSchema.parse(second.comparison);
    expect(path.isAbsolute(document.baselinePath)).toBe(false);
    expect(path.isAbsolute(document.runMetricsPath)).toBe(false);
    fixture.store.close();
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-metrics-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const runs = new TestRunRepository(store);
  const events = new EventRepository(store);
  const artifacts = new ArtifactRepository(store);
  const exports = new ArtifactExportRepository(store);
  const can = new CanTestResultRepository(store);
  new BoardRepository(store).upsert({
    boardId: "board-a", probeSerial: "XDS-A", device: "F28P65x",
    ccxmlPath: path.join(root, "board.ccxml"), tags: ["mock"]
  });
  const jobA = "metrics-a";
  const jobB = "metrics-b";
  await createRun(root, runs, exports, jobA, "plan-a", "a".repeat(64), [10, 12, 14]);
  await createRun(root, runs, exports, jobB, "plan-b", "b".repeat(64), [20, 22, 24]);
  events.append({ level: "info", sourceType: "job", sourceId: jobA, jobId: jobA, eventType: "IPC", payload: { timeoutCount: 2 } });
  const metrics = new RunMetricsService({ rootDirectory: root, runs, events, artifacts, exports, canResults: can });
  const baselines = new BaselineService({ rootDirectory: root, runs, artifacts, exports, metrics });
  return { root, store, runs, metrics, baselines, jobA, jobB };
}

async function createRun(
  root: string,
  runs: TestRunRepository,
  exports: ArtifactExportRepository,
  jobId: string,
  planName: string,
  outSha256: string,
  values: number[]
) {
  const directory = path.join(root, jobId);
  await mkdir(directory, { recursive: true });
  const manifest = {
    schemaVersion: 1, jobId, evidenceLevel: "MOCK",
    targets: [{
      boardId: "board-a",
      boardProfile: { device: "F28P65x", tags: ["mock"] },
      programs: [
        { coreId: 0, outSha256 },
        { coreId: 2, outSha256 }
      ]
    }]
  };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(path.join(directory, "variables.jsonl"), `${values.map((value, index) => JSON.stringify({
    sequence: index + 1,
    actualHostIntervalMs: 10 + index,
    variables: { g_value: { status: "OK", value } }
  })).join("\n")}\n`);
  await writeFile(path.join(directory, "dlog.json"), JSON.stringify({
    channels: [{ name: "ia", unit: "A", values: [1, 2, 3, 4] }]
  }));
  runs.create({
    jobId, planName, planVersion: 1, plan: {}, status: "PASSED", progressCurrent: 1, progressTotal: 1,
    submittedAt: "2026-07-29T00:00:00.000Z", finishedAt: "2026-07-29T00:00:01.000Z",
    cancelRequested: false, failurePolicy: {}
  }, [{ jobId, boardId: "board-a", probeSerial: "XDS-A", status: "PASSED", currentStepIndex: 0 }], [{
    stepRunId: `${jobId}-step`, jobId, boardId: "board-a", stepIndex: 0, stepType: "preflight",
    input: {}, status: "PASSED", attempt: 1, idempotencyClass: "READ_ONLY"
  }]);
  exports.upsert({ jobId, rootPath: directory, schemaVersion: 1, status: "EXPORTED", completeness: "COMPLETE", updatedAt: "2026-07-29T00:00:01.000Z" });
}

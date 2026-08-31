import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../../artifacts/AtomicArtifactWriter.js";
import type {
  VerificationArtifact,
  VerificationCheck,
  VerificationMetric,
  VerificationResult
} from "../VerificationSchemas.js";
import type { VerificationExecutionContext } from "../VerificationResultBuilder.js";
import {
  createVerificationResult,
  gateFailuresFromChecks,
  incomplete
} from "../VerificationResultBuilder.js";
import {
  mapResultSchema,
  mapVerificationInputSchema,
  type MapArtifactExpectation,
  type MapParseDocument,
  type MapRegion,
  type MapResult,
  type MapSection,
  type MapVerificationInput
} from "./MapSchemas.js";
import { C2000MapParser } from "./C2000MapParser.js";

export interface MapVerificationOutput {
  verification: VerificationResult;
  map: MapResult;
}

export interface MapVerifierOptions {
  rootDirectory: string;
  writer?: AtomicArtifactWriter;
}

export class MapVerifier {
  private readonly writer: AtomicArtifactWriter;
  private readonly parser = new C2000MapParser();

  constructor(private readonly options: MapVerifierOptions) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async verify(rawInput: unknown, context: VerificationExecutionContext): Promise<MapVerificationOutput> {
    const input = mapVerificationInputSchema.parse(rawInput);
    const started = new Date();
    const artifactDirectory = context.artifactDirectory ?? path.join(path.resolve(this.options.rootDirectory), "verification", safePath(context.verificationId));
    await this.writer.ensureDirectory(artifactDirectory);
    const checks: VerificationCheck[] = [];
    const diagnostics: VerificationResult["diagnostics"] = [];
    let mapText: string | undefined;
    let mapPath: string | undefined;
    let artifact: MapArtifactExpectation | null = null;
    if (input.mapText !== undefined) {
      mapText = input.mapText;
    } else if (input.mapPath) {
      mapPath = path.resolve(input.mapPath);
      try {
        mapText = await readFile(mapPath, "utf8");
        artifact = await mapArtifact(mapPath);
      } catch (error) {
        diagnostics.push({ code: "MAP_READ_FAILED", severity: "ERROR", message: `Unable to read map file: ${String(error)}`, source: mapPath });
        checks.push(check("map-readable", "artifact", "FAILED", "CRITICAL", "Map file could not be read", { expected: "readable map file", actual: String(error) }));
      }
    }
    if (mapText === undefined) {
      const ended = new Date();
      const result = mapResultSchema.parse({
        schemaVersion: 1,
        status: "BLOCKED",
        mapPath: mapPath ?? null,
        artifact,
        parse: emptyParse("MAP_READ_FAILED"),
        metrics: [],
        hardGateFailures: [{ check: "map-readable", message: "Map input is unavailable" }],
        durationMs: elapsed(started, ended)
      });
      const verification = createVerificationResult({
        context,
        verifierType: "map",
        status: "BLOCKED",
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        checks,
        diagnostics,
        artifacts: [],
        completeness: incomplete("MAP_READ_FAILED"),
        hardGateFailures: gateFailuresFromChecks("map", checks),
        details: { map: result }
      });
      return { verification, map: result };
    }

    const evidencePath = path.join(artifactDirectory, "evidence", "map.map");
    await this.writer.writeText(evidencePath, mapText);
    const evidenceArtifact = await fileArtifact(evidencePath, "map");
    const parse = this.parser.parse(mapText);
    if (parse.complete) checks.push(check("map-parse", "parse", "PASSED", "INFO", "TI C2000 map tables were parsed"));
    else checks.push(check("map-parse", "parse", "BLOCKED", "CRITICAL", "Map parsing is incomplete; no PASS is emitted", { expected: "complete map tables", actual: parse.errors }));
    const ruleChecks = await evaluateRules(parse, input, artifact);
    checks.push(...ruleChecks);
    const metrics = metricsFromMap(parse);
    const hardGateFailures = gateFailuresFromChecks("map", checks);
    const status = !parse.complete ? "BLOCKED"
      : checks.some(check => check.status === "BLOCKED") ? "BLOCKED"
        : hardGateFailures.length > 0 ? "FAILED"
        : "PASSED";
    const ended = new Date();
    const map = mapResultSchema.parse({
      schemaVersion: 1,
      status,
      mapPath: mapPath ?? null,
      artifact,
      parse,
      metrics: metrics.map(metric => ({
        name: metric.name,
        unit: metric.unit,
        value: metric.value,
        ...(metric.source?.startsWith("region:") ? { region: metric.source.slice("region:".length) } : {}),
        ...(metric.source?.startsWith("section:") ? { section: metric.source.slice("section:".length) } : {})
      })),
      hardGateFailures: hardGateFailures.map(failure => ({ check: failure.check, message: failure.message, ...(failure.evidence !== undefined ? { actual: failure.evidence } : {}) })),
      durationMs: elapsed(started, ended)
    });
    const verification = createVerificationResult({
      context,
      verifierType: "map",
      status,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      checks,
      metrics,
      diagnostics: [
        ...diagnostics,
        ...parse.errors.map(message => ({ code: "MAP_PARSE_ERROR", severity: "ERROR" as const, message, source: mapPath })),
        ...parse.warnings.map(message => ({ code: "MAP_PARSE_WARNING", severity: "WARNING" as const, message, source: mapPath }))
      ],
      artifacts: evidenceArtifact ? [evidenceArtifact] : [],
      evidenceClassification: "UNKNOWN",
      completeness: parse.complete
        ? { status: "COMPLETE" as const, reason: null, requiredArtifacts: mapPath ? ["map.map"] : [], presentArtifacts: evidenceArtifact ? [evidenceArtifact.path] : [] }
        : incomplete("MAP_PARSE_INCOMPLETE", evidenceArtifact ? [evidenceArtifact] : []),
      hardGateFailures,
      inputs: {
        ...(mapPath ? { mapPath } : {}),
        ...(input.expectedBuildId ? { expectedBuildId: input.expectedBuildId } : {}),
        rules: input.rules
      },
      details: { map }
    });
    return { verification, map };
  }
}

async function evaluateRules(parse: MapParseDocument, input: MapVerificationInput, actualArtifact: MapArtifactExpectation | null): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  for (const [regionName, limit] of Object.entries(input.rules.maxRegionUtilization)) {
    const region = parse.regions.find(candidate => candidate.name === regionName);
    checks.push(region
      ? check(`region-utilization:${regionName}`, "map-hard-gate", region.utilizationPct <= limit ? "PASSED" : "FAILED", region.utilizationPct <= limit ? "INFO" : "CRITICAL", region.utilizationPct <= limit ? `Region ${regionName} is within utilization limit` : `Region ${regionName} exceeds utilization limit`, { expected: limit, actual: region.utilizationPct, source: "map" })
      : check(`region-utilization:${regionName}`, "map-hard-gate", "FAILED", "CRITICAL", `Required region ${regionName} is missing from the map`, { expected: regionName, actual: null }));
  }
  for (const sectionName of input.rules.requireSections) {
    const section = parse.sections.find(candidate => candidate.name === sectionName);
    checks.push(section
      ? check(`required-section:${sectionName}`, "map-hard-gate", "PASSED", "INFO", `Required section ${sectionName} is present`)
      : check(`required-section:${sectionName}`, "map-hard-gate", "FAILED", "CRITICAL", `Required section ${sectionName} is missing`, { expected: sectionName, actual: null }));
  }
  for (const forbidden of input.rules.forbiddenPlacements) {
    const sectionName = typeof forbidden === "string" ? forbidden : forbidden.section;
    const forbiddenRegion = typeof forbidden === "string" ? undefined : forbidden.region;
    const matches = parse.sections.filter(section => section.name === sectionName && (!forbiddenRegion || section.region === forbiddenRegion));
    checks.push(matches.length === 0
      ? check(`forbidden-placement:${sectionName}`, "map-hard-gate", "PASSED", "INFO", `Forbidden placement ${sectionName}${forbiddenRegion ? ` -> ${forbiddenRegion}` : ""} was not found`)
      : check(`forbidden-placement:${sectionName}`, "map-hard-gate", "FAILED", "CRITICAL", `Forbidden placement detected for ${sectionName}`, { expected: "no placement", actual: matches.map(section => section.region) }));
  }
  const expected = input.expectedArtifact;
  if (expected && actualArtifact) {
    const mismatches = artifactMismatches(expected, actualArtifact);
    checks.push(mismatches.length === 0
      ? check("artifact-freshness", "artifact-identity", "PASSED", "INFO", "Map artifact matches the expected build artifact")
      : check("artifact-freshness", "artifact-identity", "BLOCKED", "CRITICAL", "Map artifact does not match the expected build; stale evidence is rejected", { expected, actual: actualArtifact }));
  } else if (expected && !actualArtifact) {
    checks.push(check("artifact-freshness", "artifact-identity", "BLOCKED", "CRITICAL", "Expected map artifact metadata could not be verified"));
  }
  if (input.expectedBuildId) {
    if (!input.expectedArtifact?.buildId) {
      checks.push(check("build-identity", "artifact-identity", "BLOCKED", "CRITICAL", "Expected build identity metadata is missing; map freshness cannot be proven", { expected: input.expectedBuildId, actual: null }));
    } else {
      checks.push(input.expectedArtifact.buildId === input.expectedBuildId
        ? check("build-identity", "artifact-identity", "PASSED", "INFO", "Map is bound to the expected build identity", { expected: input.expectedBuildId, actual: input.expectedArtifact.buildId })
        : check("build-identity", "artifact-identity", "BLOCKED", "CRITICAL", "Expected map metadata is bound to a different build", { expected: input.expectedBuildId, actual: input.expectedArtifact.buildId }));
    }
  }
  for (const [sectionName, limit] of Object.entries(input.rules.maxSectionGrowthPercent)) {
    if (!input.baselineMapPath) {
      checks.push(check(`section-growth:${sectionName}`, "map-baseline", "BLOCKED", "CRITICAL", "A baseline map is required for the configured section-growth gate", { expected: input.baselineMapPath, actual: null }));
      continue;
    }
    let baseline: MapParseDocument;
    try {
      baseline = new C2000MapParser().parse(await readFile(path.resolve(input.baselineMapPath), "utf8"));
    } catch (error) {
      checks.push(check(`section-growth:${sectionName}`, "map-baseline", "BLOCKED", "CRITICAL", "Baseline map could not be read", { expected: input.baselineMapPath, actual: String(error) }));
      continue;
    }
    if (!baseline.complete) {
      checks.push(check(`section-growth:${sectionName}`, "map-baseline", "BLOCKED", "CRITICAL", "Baseline map could not be parsed completely", { expected: "complete baseline map", actual: baseline.errors }));
      continue;
    }
    const currentSection = parse.sections.find(section => section.name === sectionName);
    const baselineSection = baseline.sections.find(section => section.name === sectionName);
    if (!currentSection || !baselineSection) {
      checks.push(check(`section-growth:${sectionName}`, "map-baseline", "FAILED", "CRITICAL", "Current or baseline section is missing", { expected: sectionName, actual: { current: currentSection?.size ?? null, baseline: baselineSection?.size ?? null } }));
      continue;
    }
    const growth = baselineSection.size === 0
      ? currentSection.size === 0 ? 0 : Number.POSITIVE_INFINITY
      : ((currentSection.size - baselineSection.size) / baselineSection.size) * 100;
    checks.push(growth <= limit
      ? check(`section-growth:${sectionName}`, "map-baseline", "PASSED", "INFO", `Section ${sectionName} growth is within the configured limit`, { expected: limit, actual: growth })
      : check(`section-growth:${sectionName}`, "map-baseline", "FAILED", "CRITICAL", `Section ${sectionName} growth exceeds the configured limit`, { expected: limit, actual: growth }));
  }
  return checks;
}

function metricsFromMap(parse: MapParseDocument): VerificationMetric[] {
  const metrics: VerificationMetric[] = [];
  let flashUsed = 0;
  let ramUsed = 0;
  let claUsed = 0;
  let claCapacity = 0;
  for (const region of parse.regions) {
    metrics.push({ name: `${region.name}.used`, unit: "bytes", value: region.used, source: `region:${region.name}` });
    metrics.push({ name: `${region.name}.free`, unit: "bytes", value: region.unused, source: `region:${region.name}` });
    metrics.push({ name: `${region.name}.utilization`, unit: "percent", value: region.utilizationPct, source: `region:${region.name}` });
    if (/FLASH/i.test(region.name)) flashUsed += region.used;
    else if (/RAM|MSGRAM/i.test(region.name)) ramUsed += region.used;
    if (/CLA/i.test(region.name)) { claUsed += region.used; claCapacity += region.length; }
  }
  metrics.push({ name: "flash.used", unit: "bytes", value: flashUsed, source: "map:aggregate" });
  metrics.push({ name: "ram.used", unit: "bytes", value: ramUsed, source: "map:aggregate" });
  metrics.push({ name: "cla.program.utilization", unit: "percent", value: claCapacity === 0 ? null : (claUsed / claCapacity) * 100, source: "map:aggregate" });
  for (const section of parse.sections) {
    metrics.push({ name: `section.${section.name}.size`, unit: "bytes", value: section.size, source: `section:${section.name}` });
    if (/^\.stack$/i.test(section.name)) metrics.push({ name: "stack.static.bytes", unit: "bytes", value: section.size, source: "section:.stack" });
  }
  return metrics;
}

async function mapArtifact(filePath: string): Promise<MapArtifactExpectation> {
  const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  if (!metadata.isFile()) throw new Error(`Map path is not a file: ${filePath}`);
  return { path: path.resolve(filePath), sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: metadata.mtimeMs };
}

async function fileArtifact(filePath: string, kind: string): Promise<VerificationArtifact | null> {
  try {
    const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
    if (!metadata.isFile()) return null;
    return { path: path.resolve(filePath), artifactType: `verification:${kind}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: metadata.size, mtimeMs: metadata.mtimeMs, completeness: "COMPLETE", role: "evidence" };
  } catch {
    return null;
  }
}

function artifactMismatches(expected: MapArtifactExpectation, actual: MapArtifactExpectation): string[] {
  return [
    expected.path && actual.path !== path.resolve(expected.path) ? "path" : undefined,
    expected.sha256 && actual.sha256 !== expected.sha256 ? "sha256" : undefined,
    expected.mtimeMs !== undefined && actual.mtimeMs !== expected.mtimeMs ? "mtimeMs" : undefined
  ].filter((value): value is string => Boolean(value));
}

function check(
  id: string,
  category: string,
  status: VerificationCheck["status"],
  severity: VerificationCheck["severity"],
  message: string,
  values: { expected?: unknown; actual?: unknown; source?: string } = {}
): VerificationCheck {
  return { id, category, status, severity, message, ...values };
}

function emptyParse(reason: string): MapParseDocument {
  return { schemaVersion: 1, format: "UNKNOWN", complete: false, memoryTablePresent: false, sectionTablePresent: false, errors: [reason], warnings: [], regions: [], sections: [] };
}

function elapsed(start: Date, end: Date): number { return Math.max(0, end.getTime() - start.getTime()); }

function safePath(value: string): string {
  return value.split("/").map(part => part.replace(/[^A-Za-z0-9._-]/g, "_")).filter(Boolean).join(path.sep);
}

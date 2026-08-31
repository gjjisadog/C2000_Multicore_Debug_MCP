import { randomUUID, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import { deterministicStatistics } from "../analytics/DeterministicStatistics.js";
import { METRIC_SCHEMA_VERSION, runMetricsDocumentSchema } from "../analytics/MetricSchemas.js";
import { assertAllowedReadPath, assertAllowedWritePath, type FilesystemPolicy } from "../security/pathPolicy.js";
import {
  verificationArtifactManifestSchema,
  verificationIndexSchema,
  verificationResultSchema,
  verificationSubjectSchema,
  verificationIdentitySchema,
  type VerificationArtifact,
  type VerificationArtifactManifest,
  type VerificationCheck,
  type VerificationIdentity,
  type VerificationResult,
  type VerificationSubject,
  type VerifierType
} from "./VerificationSchemas.js";
import {
  createVerificationResult,
  incomplete,
  gateFailuresFromChecks,
  type VerificationExecutionContext
} from "./VerificationResultBuilder.js";
import {
  ConfiguredProcessBuildProvider,
  BuildVerifier,
  type BuildProvider,
  type BuildVerificationOutput
} from "./build/BuildVerifier.js";
import { buildVerificationInputSchema, type BuildVerificationInput } from "./build/BuildSchemas.js";
import { MapVerifier, type MapVerificationOutput } from "./map/MapVerifier.js";
import { mapVerificationInputSchema, type MapArtifactExpectation, type MapVerificationInput } from "./map/MapSchemas.js";
import { RegressionVerifier, type RegressionVerificationOutput } from "./regression/RegressionVerifier.js";
import { regressionPlanSchema, type RegressionPlan } from "./regression/RegressionSchemas.js";
import { ReviewVerifier, type ReviewVerificationOutput } from "./review/ReviewVerifier.js";
import { reviewVerificationInputSchema } from "./review/ReviewSchemas.js";
import { verificationConfigSchema, verificationRuleFileSchema, type VerificationConfig, type VerificationRuleFile } from "./VerificationConfigSchemas.js";
import { z } from "zod";

const verificationIdSchema = z.string().regex(/^[A-Za-z0-9._/-]+$/);

export const engineeringVerificationInputSchema = z.object({
  verificationId: verificationIdSchema.optional(),
  parentVerificationId: verificationIdSchema.nullable().optional(),
  jobId: z.string().min(1).optional(),
  subject: verificationSubjectSchema.optional(),
  identity: verificationIdentitySchema.default({}),
  outputDir: z.string().min(1).optional(),
  failFast: z.boolean().default(true),
  stages: z.object({
    build: z.boolean().default(true),
    map: z.boolean().default(true),
    regression: z.boolean().default(true),
    review: z.boolean().default(true)
  }).default({}),
  build: buildVerificationInputSchema.optional(),
  map: mapVerificationInputSchema.optional(),
  regression: regressionPlanSchema.optional(),
  review: reviewVerificationInputSchema.optional()
});

export type EngineeringVerificationInput = z.infer<typeof engineeringVerificationInputSchema>;

export interface VerificationArtifactRegistration {
  jobId: string;
  artifactType: string;
  path: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface VerificationServiceOptions {
  rootDirectory: string;
  filesystem?: FilesystemPolicy;
  config?: unknown;
  writer?: AtomicArtifactWriter;
  buildVerifier?: BuildVerifier;
  mapVerifier?: MapVerifier;
  regressionVerifier?: RegressionVerifier;
  reviewVerifier?: ReviewVerifier;
  buildProviders?: Record<string, BuildProvider>;
  registerArtifact?: (artifact: VerificationArtifactRegistration) => void | Promise<void>;
}

export interface EngineeringVerificationOutput {
  verificationId: string;
  verification: VerificationResult;
  build: BuildVerificationOutput | null;
  map: MapVerificationOutput | null;
  regression: RegressionVerificationOutput | null;
  review: ReviewVerificationOutput | null;
  finalGate: {
    status: VerificationResult["status"];
    decision: "PASS" | "REJECT" | "BLOCK";
    hardGateFailures: VerificationResult["hardGateFailures"];
  };
  artifactManifestPath: string;
  artifactManifest: VerificationArtifactManifest;
}

export interface PersistedVerification {
  verification: VerificationResult;
  manifest: VerificationArtifactManifest;
  artifactManifestPath: string;
  resultPath: string;
  verificationPath: string;
}

export class VerificationService {
  private readonly writer: AtomicArtifactWriter;
  private config: VerificationConfig;
  private projectRulesLoad?: Promise<void>;
  private readonly buildVerifier: BuildVerifier;
  private readonly mapVerifier: MapVerifier;
  private readonly regressionVerifier: RegressionVerifier;
  private readonly reviewVerifier: ReviewVerifier;
  private readonly rootDirectory: string;

  constructor(private readonly options: VerificationServiceOptions) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.config = verificationConfigSchema.parse(options.config ?? {});
    const providers: Record<string, BuildProvider> = { ...(options.buildProviders ?? {}) };
    for (const [id, providerConfig] of Object.entries(this.config.build.providers)) {
      providers[id] = new ConfiguredProcessBuildProvider({ id, ...providerConfig });
    }
    this.buildVerifier = options.buildVerifier ?? new BuildVerifier({ rootDirectory: this.rootDirectory, writer: this.writer, providers });
    this.mapVerifier = options.mapVerifier ?? new MapVerifier({ rootDirectory: this.rootDirectory, writer: this.writer });
    this.regressionVerifier = options.regressionVerifier ?? new RegressionVerifier({ rootDirectory: this.rootDirectory, writer: this.writer });
    this.reviewVerifier = options.reviewVerifier ?? new ReviewVerifier({ rootDirectory: this.rootDirectory, writer: this.writer });
  }

  async verifyBuild(rawInput: unknown): Promise<Record<string, unknown>> {
    await this.ensureProjectRules();
    const input = buildVerificationInputSchema.parse({
      ...(isRecord(rawInput) ? rawInput : {}),
      providerId: isRecord(rawInput) && rawInput.providerId !== undefined ? rawInput.providerId : this.config.build.defaultProvider
    });
    const context = await this.stageContext("build", input, "build");
    const output = await this.buildVerifier.verify(input, context);
    const persisted = await this.persist(output.verification, context.artifactDirectory!);
    return { verificationId: context.verificationId, verification: persisted.verification, build: output.build, artifactManifestPath: persisted.artifactManifestPath, artifactManifest: persisted.manifest };
  }

  async verifyMap(rawInput: unknown): Promise<Record<string, unknown>> {
    await this.ensureProjectRules();
    const input = mapVerificationInputSchema.parse({
      ...(isRecord(rawInput) ? rawInput : {}),
      rules: { ...this.config.map.rules, ...(isRecord(rawInput) && isRecord(rawInput.rules) ? rawInput.rules : {}) }
    });
    const context = await this.stageContext("map", input, "map");
    const output = await this.mapVerifier.verify(input, context);
    const persisted = await this.persist(output.verification, context.artifactDirectory!);
    return { verificationId: context.verificationId, verification: persisted.verification, map: output.map, artifactManifestPath: persisted.artifactManifestPath, artifactManifest: persisted.manifest };
  }

  async verifyRegression(rawInput: unknown): Promise<Record<string, unknown>> {
    await this.ensureProjectRules();
    const input = regressionPlanSchema.parse(rawInput);
    const context = await this.stageContext("regression", input, "regression");
    const output = await this.regressionVerifier.verify(input, context);
    const persisted = await this.persist(output.verification, context.artifactDirectory!);
    return { verificationId: context.verificationId, verification: persisted.verification, regression: output.regression, artifactManifestPath: persisted.artifactManifestPath, artifactManifest: persisted.manifest };
  }

  async verifyReview(rawInput: unknown): Promise<Record<string, unknown>> {
    await this.ensureProjectRules();
    const input = reviewVerificationInputSchema.parse({
      ...(isRecord(rawInput) ? rawInput : {}),
      rules: { ...this.config.review.rules, ...(isRecord(rawInput) && isRecord(rawInput.rules) ? rawInput.rules : {}) }
    });
    const context = await this.stageContext("review", input, "review");
    const output = await this.reviewVerifier.verify(input, context);
    const persisted = await this.persist(output.verification, context.artifactDirectory!);
    return { verificationId: context.verificationId, verification: persisted.verification, review: output.review, artifactManifestPath: persisted.artifactManifestPath, artifactManifest: persisted.manifest };
  }

  async runEngineeringVerification(rawInput: unknown): Promise<EngineeringVerificationOutput> {
    await this.ensureProjectRules();
    const input = engineeringVerificationInputSchema.parse(rawInput);
    const verificationId = input.verificationId ?? `verify_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`;
    const outputRoot = await this.resolveOutputRoot(input.outputDir);
    const childResults: Array<{ verificationId: string; verifierType: VerifierType; status: VerificationResult["status"]; resultPath: string }> = [];
    const stageChecks: VerificationCheck[] = [];
    const hardGateFailures: VerificationResult["hardGateFailures"] = [];
    const started = new Date();
    let build: BuildVerificationOutput | null = null;
    let map: MapVerificationOutput | null = null;
    let regression: RegressionVerificationOutput | null = null;
    let review: ReviewVerificationOutput | null = null;

    if (input.stages.build && this.config.build.enabled) {
      if (!input.build) {
        const blocked = await this.persist(this.blockedResult(this.context(`${verificationId}/build`, "build", { ...input, parentVerificationId: verificationId }), "build", "BUILD_INPUT_MISSING", "Build stage requires a declared build input"), await this.stageDirectory(outputRoot, verificationId, "build"));
        childResults.push(child(blocked));
        stageChecks.push(stageCheck("build", blocked.verification));
      } else {
        const buildInput = buildVerificationInputSchema.parse({
          ...input.build,
          providerId: input.build.providerId ?? this.config.build.defaultProvider,
          ...(input.jobId && !input.build.jobId ? { jobId: input.jobId } : {})
        });
        const context = this.context(`${verificationId}/build`, "build", { ...input, parentVerificationId: verificationId }, await this.stageDirectory(outputRoot, verificationId, "build"));
        build = await this.buildVerifier.verify(buildInput, context);
        const persisted = await this.persist(build.verification, context.artifactDirectory!);
        childResults.push(child(persisted));
        stageChecks.push(stageCheck("build", persisted.verification));
        hardGateFailures.push(...persisted.verification.hardGateFailures);
      }
    } else {
      stageChecks.push(skippedStageCheck("build", "Build stage is disabled by configuration or request"));
    }

    const buildPassed = !input.stages.build || !this.config.build.enabled || Boolean(build && build.verification.status === "PASSED" && build.verification.completeness.status === "COMPLETE");
    if (input.stages.map && this.config.map.enabled) {
      if (!buildPassed) {
        const blocked = await this.persist(this.blockedResult(this.context(`${verificationId}/map`, "map", { ...input, parentVerificationId: verificationId }), "map", "BUILD_GATE_FAILED", "Map stage is blocked because the current build did not pass; stale map evidence is not reused"), await this.stageDirectory(outputRoot, verificationId, "map"));
        childResults.push(child(blocked));
        stageChecks.push(stageCheck("map", blocked.verification));
      } else {
        const buildMap = build?.build.artifacts.map ?? null;
        const rawMap = input.map ? { ...input.map } : undefined;
        const mapPath = rawMap?.mapPath ?? buildMap?.path;
        const expectedArtifact: MapArtifactExpectation | undefined = rawMap?.expectedArtifact ?? (buildMap ? { path: buildMap.path, sha256: buildMap.sha256, mtimeMs: buildMap.mtimeMs, ...(buildMap.buildId ? { buildId: buildMap.buildId } : {}) } : undefined);
        if (!mapPath && !rawMap?.mapText) {
          const blocked = await this.persist(this.blockedResult(this.context(`${verificationId}/map`, "map", { ...input, parentVerificationId: verificationId }), "map", "MAP_INPUT_MISSING", "Map stage requires a mapPath/mapText or a map artifact emitted by the current build"), await this.stageDirectory(outputRoot, verificationId, "map"));
          childResults.push(child(blocked));
          stageChecks.push(stageCheck("map", blocked.verification));
        } else if (build && !buildMap && !rawMap?.mapText) {
          const blocked = await this.persist(this.blockedResult(this.context(`${verificationId}/map`, "map", { ...input, parentVerificationId: verificationId }), "map", "BUILD_MAP_ARTIFACT_MISSING", "Current build did not emit map metadata; existing map files are not accepted as current evidence"), await this.stageDirectory(outputRoot, verificationId, "map"));
          childResults.push(child(blocked));
          stageChecks.push(stageCheck("map", blocked.verification));
        } else {
          const mapInput = mapVerificationInputSchema.parse({
            ...rawMap,
            ...(mapPath ? { mapPath } : {}),
            rules: { ...this.config.map.rules, ...(rawMap?.rules ?? {}) },
            ...(expectedArtifact ? { expectedArtifact } : {}),
            ...(buildMap?.buildId ? { expectedBuildId: buildMap.buildId } : {}),
            ...(input.jobId && !rawMap?.jobId ? { jobId: input.jobId } : {})
          });
          const context = this.context(`${verificationId}/map`, "map", { ...input, parentVerificationId: verificationId }, await this.stageDirectory(outputRoot, verificationId, "map"));
          map = await this.mapVerifier.verify(mapInput, context);
          const persisted = await this.persist(map.verification, context.artifactDirectory!);
          childResults.push(child(persisted));
          stageChecks.push(stageCheck("map", persisted.verification));
          hardGateFailures.push(...persisted.verification.hardGateFailures);
        }
      }
    } else {
      stageChecks.push(skippedStageCheck("map", "Map stage is disabled by configuration or request"));
    }

    if (input.stages.regression && this.config.regression.enabled) {
      const plan = input.regression ?? this.config.regression.plan ?? { suites: ["host-unit"] };
      if (!buildPassed) {
        const blocked = await this.persist(this.blockedResult(this.context(`${verificationId}/regression`, "regression", { ...input, parentVerificationId: verificationId }), "regression", "BUILD_GATE_FAILED", "Regression stage is blocked because the current build did not pass"), await this.stageDirectory(outputRoot, verificationId, "regression"));
        childResults.push(child(blocked));
        stageChecks.push(stageCheck("regression", blocked.verification));
      } else {
        const context = this.context(`${verificationId}/regression`, "regression", { ...input, parentVerificationId: verificationId }, await this.stageDirectory(outputRoot, verificationId, "regression"));
        const planRecord = plan as RegressionPlan;
        regression = await this.regressionVerifier.verify(regressionPlanSchema.parse({ ...plan, ...(input.jobId && !planRecord.jobId ? { jobId: input.jobId } : {}) }), context);
        const persisted = await this.persist(regression.verification, context.artifactDirectory!);
        childResults.push(child(persisted));
        stageChecks.push(stageCheck("regression", persisted.verification));
        hardGateFailures.push(...persisted.verification.hardGateFailures);
      }
    } else {
      stageChecks.push(skippedStageCheck("regression", "Regression stage is disabled by configuration or request"));
    }

    if (input.stages.review && this.config.review.enabled) {
      if (!input.review) {
        const blocked = await this.persist(this.blockedResult(this.context(`${verificationId}/review`, "review", { ...input, parentVerificationId: verificationId }), "review", "REVIEW_INPUT_MISSING", "Review stage requires diffText, diffPath, or changedFiles"), await this.stageDirectory(outputRoot, verificationId, "review"));
        childResults.push(child(blocked));
        stageChecks.push(stageCheck("review", blocked.verification));
      } else {
        const context = this.context(`${verificationId}/review`, "review", { ...input, parentVerificationId: verificationId }, await this.stageDirectory(outputRoot, verificationId, "review"));
        review = await this.reviewVerifier.verify(reviewVerificationInputSchema.parse({ ...input.review, rules: { ...this.config.review.rules, ...(input.review.rules ?? {}) }, ...(input.jobId && !input.review.jobId ? { jobId: input.jobId } : {}) }), context);
        const persisted = await this.persist(review.verification, context.artifactDirectory!);
        childResults.push(child(persisted));
        stageChecks.push(stageCheck("review", persisted.verification));
        hardGateFailures.push(...persisted.verification.hardGateFailures);
      }
    } else {
      stageChecks.push(skippedStageCheck("review", "Review stage is disabled by configuration or request"));
    }

    const ended = new Date();
    const finalStatus = finalStatusFor(stageChecks, hardGateFailures);
    const finalDecision = finalDecisionFor(finalStatus, hardGateFailures);
    const suiteContext = this.context(verificationId, "suite", input, await this.stageDirectory(outputRoot, verificationId, "suite"));
    const suite = createVerificationResult({
      context: suiteContext,
      verifierType: "suite",
      status: finalStatus,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      checks: stageChecks,
      artifacts: [],
      completeness: stageChecks.some(check => check.status === "BLOCKED" || check.status === "UNSUPPORTED")
        ? incomplete("ENGINEERING_VERIFICATION_INCOMPLETE")
        : { status: "COMPLETE", reason: null, requiredArtifacts: [], presentArtifacts: [] },
      hardGateFailures,
      children: childResults,
      inputs: { stages: input.stages, failFast: input.failFast },
      details: { finalGate: { status: finalStatus, decision: finalDecision, hardGateFailures } },
      summaryMessage: `Engineering verification ${finalDecision}: ${stageChecks.filter(check => check.status === "PASSED").length}/${stageChecks.length} stage checks passed`
    });
    const persisted = await this.persist(suite, suiteContext.artifactDirectory!);
    return {
      verificationId,
      verification: persisted.verification,
      build,
      map,
      regression,
      review,
      finalGate: { status: finalStatus, decision: finalDecision, hardGateFailures },
      artifactManifestPath: persisted.artifactManifestPath,
      artifactManifest: persisted.manifest
    };
  }

  async getVerificationResult(rawInput: unknown): Promise<Record<string, unknown>> {
    const input = z.object({ verificationId: verificationIdSchema }).parse(rawInput);
    const index = await this.readIndex();
    const indexed = index.entries[input.verificationId];
    const resultPath = indexed?.resultPath ?? path.join(this.rootDirectory, safeRelativeId(input.verificationId), "result.json");
    const manifestPath = indexed?.manifestPath ?? path.join(path.dirname(resultPath), "manifest.json");
    const result = verificationResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
    let manifest: VerificationArtifactManifest | null = null;
    try { manifest = verificationArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))); } catch { manifest = null; }
    return { verificationId: input.verificationId, verification: result, artifactManifest: manifest, artifactManifestPath: manifestPath };
  }

  private async stageContext(stage: VerifierType, input: { verificationId?: string; parentVerificationId?: string | null; jobId?: string; outputDir?: string }, suffix: string): Promise<VerificationExecutionContext> {
    const verificationId = input.verificationId ?? `verify_${randomUUID()}`;
    const root = await this.resolveOutputRoot(input.outputDir);
    return this.context(verificationId, stage, input, await this.stageDirectory(root, verificationId, suffix));
  }

  private context(
    verificationId: string,
    verifierType: VerifierType,
    input: { parentVerificationId?: string | null; jobId?: string; subject?: VerificationSubject; identity?: VerificationIdentity },
    artifactDirectory?: string
  ): VerificationExecutionContext {
    const id = verificationIdSchema.parse(verificationId);
    return {
      verificationId: id,
      ...(input.parentVerificationId ? { parentVerificationId: input.parentVerificationId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      artifactDirectory,
      subject: input.subject ?? { kind: verifierType, id },
      identity: input.identity ?? {}
    };
  }

  private async resolveOutputRoot(outputDir?: string): Promise<string> {
    const candidate = path.resolve(outputDir ?? this.config.artifactDirectory ?? this.rootDirectory);
    if (this.options.filesystem) await assertAllowedWritePath(candidate, this.options.filesystem);
    await this.writer.ensureDirectory(candidate);
    return candidate;
  }

  private async ensureProjectRules(): Promise<void> {
    if (!this.config.rulesFile) return;
    this.projectRulesLoad ??= this.loadProjectRules(this.config.rulesFile);
    await this.projectRulesLoad;
  }

  private async loadProjectRules(rulesFile: string): Promise<void> {
    const rulesPath = path.resolve(rulesFile);
    if (this.options.filesystem) await assertAllowedReadPath(rulesPath, this.options.filesystem);
    const projectRules = verificationRuleFileSchema.parse(JSON.parse(await readFile(rulesPath, "utf8")));
    this.config = mergeProjectRules(this.config, projectRules);
  }

  private async stageDirectory(root: string, verificationId: string, stage: string): Promise<string> {
    const directory = path.join(root, safeRelativeId(verificationId), stage);
    await this.writer.ensureDirectory(directory);
    return directory;
  }

  private blockedResult(context: VerificationExecutionContext, verifierType: VerifierType, code: string, message: string): VerificationResult {
    const started = new Date();
    const ended = new Date();
    const checks: VerificationCheck[] = [{ id: code.toLowerCase(), category: "precondition", status: "BLOCKED", severity: "CRITICAL", message, actual: null }];
    return createVerificationResult({
      context,
      verifierType,
      status: "BLOCKED",
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      checks,
      diagnostics: [{ code, severity: "ERROR", message }],
      completeness: incomplete(code),
      hardGateFailures: gateFailuresFromChecks(verifierType, checks),
      inputs: { precondition: code }
    });
  }

  private async persist(verification: VerificationResult, artifactDirectory: string): Promise<PersistedVerification> {
    const resultPath = path.join(artifactDirectory, "result.json");
    const verificationPath = path.join(artifactDirectory, "verification.json");
    const metricsPath = path.join(artifactDirectory, "metrics.json");
    const manifestPath = path.join(artifactDirectory, "manifest.json");
    await this.writer.ensureDirectory(artifactDirectory);
    await this.writer.writeJson(resultPath, verification);
    await this.writer.writeJson(verificationPath, verification);
    const verificationFile = await artifactMetadata(verificationPath, "verification:result", "verification");
    const metricDocument = runMetricsDocumentSchema.parse({
      schemaVersion: METRIC_SCHEMA_VERSION,
      jobId: verification.jobId ?? verification.verificationId,
      generatedAt: verification.endedAt,
      percentileMethod: "linear-r7",
      standardDeviation: "population",
      evidenceLevel: verification.evidenceClassification,
      metrics: verification.metrics.map(metric => ({
        name: metric.name,
        unit: metric.unit,
        statistics: deterministicStatistics(metric.value === null ? [null] : [metric.value]),
        rawSamples: metric.value === null ? [] : [metric.value],
        sources: [{ kind: "artifact", path: "verification.json", sha256: verificationFile.sha256, selector: metric.source ?? metric.name, evidenceLevel: verification.evidenceClassification }]
      }))
    });
    await this.writer.writeJson(metricsPath, metricDocument);
    const persistedFiles = await Promise.all([
      artifactMetadata(resultPath, "verification:result", "result"),
      Promise.resolve(verificationFile),
      artifactMetadata(metricsPath, "verification:metrics", "metrics")
    ]);
    const evidence = [...verification.artifacts, ...persistedFiles].filter((artifact, index, all) => all.findIndex(candidate => candidate.path === artifact.path) === index);
    const completeness = verification.completeness.status === "COMPLETE"
      ? { status: "COMPLETE" as const, reason: null, requiredArtifacts: [], presentArtifacts: evidence.map(artifact => artifact.path) }
      : { ...verification.completeness, presentArtifacts: evidence.map(artifact => artifact.path) };
    const manifest = verificationArtifactManifestSchema.parse({
      schemaVersion: 1,
      kind: "verification-artifact-manifest",
      verificationId: verification.verificationId,
      verifierType: verification.verifierType,
      ...(verification.jobId ? { jobId: verification.jobId } : {}),
      resultPath,
      verificationPath,
      artifacts: evidence,
      completeness,
      createdAt: new Date().toISOString()
    });
    // The manifest is the commit marker and is intentionally written last.
    await this.writer.writeJson(manifestPath, manifest);
    await this.updateIndex(verification, resultPath, manifestPath);
    await this.registerArtifacts(verification, [...evidence, await artifactMetadata(manifestPath, "verification:manifest", "manifest")]);
    return { verification, manifest, artifactManifestPath: manifestPath, resultPath, verificationPath };
  }

  private async updateIndex(verification: VerificationResult, resultPath: string, manifestPath: string): Promise<void> {
    const index = await this.readIndex();
    index.entries[verification.verificationId] = {
      resultPath,
      manifestPath,
      verifierType: verification.verifierType,
      ...(verification.jobId ? { jobId: verification.jobId } : {}),
      updatedAt: new Date().toISOString()
    };
    await this.writer.writeJson(path.join(this.rootDirectory, "verification-index.json"), index);
  }

  private async readIndex() {
    try { return verificationIndexSchema.parse(JSON.parse(await readFile(path.join(this.rootDirectory, "verification-index.json"), "utf8"))); }
    catch { return { schemaVersion: 1 as const, entries: {} }; }
  }

  private async registerArtifacts(verification: VerificationResult, artifacts: VerificationArtifact[]): Promise<void> {
    if (!verification.jobId || !this.options.registerArtifact) return;
    for (const artifact of artifacts) {
      try {
        await this.options.registerArtifact({ jobId: verification.jobId, artifactType: artifact.artifactType, path: artifact.path, sha256: artifact.sha256, size: artifact.size, createdAt: new Date().toISOString() });
      } catch {
        // Filesystem evidence is already committed. A repository registration
        // failure must not erase or turn a durable verifier result into text.
      }
    }
  }
}

function child(value: PersistedVerification): { verificationId: string; verifierType: VerifierType; status: VerificationResult["status"]; resultPath: string } {
  return { verificationId: value.verification.verificationId, verifierType: value.verification.verifierType, status: value.verification.status, resultPath: value.resultPath };
}

function stageCheck(stage: string, result: VerificationResult): VerificationCheck {
  const status: VerificationCheck["status"] = result.completeness.status !== "COMPLETE" && result.status === "PASSED"
    ? "BLOCKED"
    : result.status === "PASSED" ? "PASSED" : result.status === "FAILED" || result.status === "ERROR" ? "FAILED" : result.status;
  return { id: `stage:${stage}`, category: "engineering-verification", status, severity: status === "PASSED" ? "INFO" : "CRITICAL", message: result.completeness.status !== "COMPLETE" ? `${stage}: incomplete evidence` : `${stage}: ${result.status}`, evidence: result.verificationId };
}

function skippedStageCheck(stage: string, message: string): VerificationCheck {
  return { id: `stage:${stage}`, category: "engineering-verification", status: "SKIPPED", severity: "INFO", message };
}

function finalStatusFor(checks: VerificationCheck[], hardGateFailures: VerificationResult["hardGateFailures"]): VerificationResult["status"] {
  if (checks.some(check => check.status === "FAILED")) return "FAILED";
  if (checks.some(check => check.status === "BLOCKED")) return "BLOCKED";
  if (checks.some(check => check.status === "UNSUPPORTED")) return "UNSUPPORTED";
  if (hardGateFailures.length > 0) return "FAILED";
  if (checks.length === 0 || checks.every(check => check.status === "SKIPPED")) return "BLOCKED";
  return "PASSED";
}

function finalDecisionFor(status: VerificationResult["status"], hardGateFailures: VerificationResult["hardGateFailures"]): "PASS" | "REJECT" | "BLOCK" {
  if (status === "BLOCKED" || status === "UNSUPPORTED") return "BLOCK";
  return status === "PASSED" && hardGateFailures.length === 0 ? "PASS" : "REJECT";
}

async function artifactMetadata(filePath: string, artifactType: string, role: string): Promise<VerificationArtifact> {
  const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  return { path: path.resolve(filePath), artifactType, sha256: createHash("sha256").update(bytes).digest("hex"), size: metadata.size, mtimeMs: metadata.mtimeMs, completeness: "COMPLETE", role };
}

function safeRelativeId(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error(`Unsafe verification id: ${value}`);
  return parts.join(path.sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeProjectRules(config: VerificationConfig, projectRules: VerificationRuleFile): VerificationConfig {
  return verificationConfigSchema.parse({
    ...config,
    build: {
      ...config.build,
      ...(projectRules.build ?? {})
    },
    map: {
      ...config.map,
      rules: {
        ...config.map.rules,
        ...(projectRules.map?.rules ?? {})
      }
    },
    regression: {
      ...config.regression,
      ...(projectRules.regression?.plan ? { plan: projectRules.regression.plan } : {})
    },
    review: {
      ...config.review,
      rules: {
        ...config.review.rules,
        ...(projectRules.review?.rules ?? {})
      }
    }
  });
}

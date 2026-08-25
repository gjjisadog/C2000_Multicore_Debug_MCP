import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import { AtomicArtifactWriter } from "./AtomicArtifactWriter.js";

export const ACCEPTANCE_CLOSURE_SCHEMA_VERSION = "dk9-acceptance-closure-v1" as const;

export interface CreateAcceptanceClosureInput {
  jobId: string;
  offlineJsonPath: string;
  offlineCsvPath: string;
  offlineMarkdownPath: string;
  outputPath?: string;
}

export interface AcceptanceClosureVerification {
  valid: boolean;
  selfHashMatched: boolean;
  boundFilesMatched: boolean;
  baseManifestUnchanged: boolean;
  failures: string[];
}

export class AcceptanceClosureService {
  constructor(private readonly options: {
    rootDirectory: string;
    artifacts: ArtifactRepository;
    writer?: AtomicArtifactWriter;
  }) {}

  async create(input: CreateAcceptanceClosureInput): Promise<Record<string, unknown>> {
    const artifactDirectory = this.jobDirectory(input.jobId);
    const basePaths = {
      manifest: path.join(artifactDirectory, "manifest.json"),
      result: path.join(artifactDirectory, "result.json"),
      expressionSnapshots: path.join(artifactDirectory, "expression-snapshots.json")
    };
    const detachedPaths = {
      offlineJson: path.resolve(input.offlineJsonPath),
      offlineCsv: path.resolve(input.offlineCsvPath),
      offlineMarkdown: path.resolve(input.offlineMarkdownPath)
    };
    const outputPath = path.resolve(input.outputPath ?? path.join(artifactDirectory, "acceptance-closure.json"));
    await Promise.all(Object.values(basePaths).map(filePath => requireFile(filePath)));
    await Promise.all(Object.values(detachedPaths).map(filePath => requireFile(filePath)));
    await this.assertNotCircular(outputPath, basePaths.manifest);

    const baseArtifacts = await hashFiles(basePaths);
    const detachedArtifacts = await hashFiles(detachedPaths);
    const payload = {
      schemaVersion: ACCEPTANCE_CLOSURE_SCHEMA_VERSION,
      kind: "detached-acceptance-attestation",
      jobId: input.jobId,
      createdAt: new Date().toISOString(),
      baseArtifacts,
      detachedArtifacts,
      verification: {
        hashAlgorithm: "sha256",
        baseManifestReferencesClosure: false,
        detachedFromCanonicalManifest: true,
        selfHashExcludes: ["attestationSha256"]
      }
    };
    const attestationSha256 = sha256Text(JSON.stringify(payload));
    const record = { ...payload, attestationSha256 };
    const writer = this.options.writer ?? new AtomicArtifactWriter();
    await writer.writeJson(outputPath, record);
    const outputInfo = await fileInfo(outputPath);
    const verification = await this.verify(outputPath);
    if (!verification.valid) {
      throw new Error(`Acceptance closure verification failed: ${verification.failures.join("; ")}`);
    }
    const artifactId = this.options.artifacts.upsert({
      jobId: input.jobId,
      artifactType: "acceptance:detached-closure",
      path: outputPath,
      sha256: outputInfo.sha256,
      size: outputInfo.size,
      createdAt: payload.createdAt
    });
    return {
      success: true,
      jobId: input.jobId,
      schemaVersion: ACCEPTANCE_CLOSURE_SCHEMA_VERSION,
      closurePath: outputPath,
      closureSha256: outputInfo.sha256,
      attestationSha256,
      artifactId,
      verification
    };
  }

  async verify(closurePath: string): Promise<AcceptanceClosureVerification> {
    const failures: string[] = [];
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(await readFile(path.resolve(closurePath), "utf8")) as Record<string, unknown>;
    } catch (error) {
      return { valid: false, selfHashMatched: false, boundFilesMatched: false, baseManifestUnchanged: false, failures: [`closure-read:${String(error)}`] };
    }
    if (record.schemaVersion !== ACCEPTANCE_CLOSURE_SCHEMA_VERSION) failures.push("schemaVersion");
    const attestationSha256 = typeof record.attestationSha256 === "string" ? record.attestationSha256 : undefined;
    const { attestationSha256: _ignored, ...payload } = record;
    const selfHashMatched = Boolean(attestationSha256 && attestationSha256 === sha256Text(JSON.stringify(payload)));
    if (!selfHashMatched) failures.push("attestationSha256");

    const baseArtifacts = record.baseArtifacts;
    const detachedArtifacts = record.detachedArtifacts;
    const boundPaths = [
      ...artifactPaths(baseArtifacts),
      ...artifactPaths(detachedArtifacts)
    ];
    let boundFilesMatched = true;
    for (const entry of boundPaths) {
      try {
        const info = await fileInfo(entry.path);
        if (info.sha256 !== entry.sha256 || info.size !== entry.size) {
          boundFilesMatched = false;
          failures.push(`artifact-hash:${entry.path}`);
        }
      } catch (error) {
        boundFilesMatched = false;
        failures.push(`artifact-read:${entry.path}:${String(error)}`);
      }
    }

    let baseManifestUnchanged = false;
    const manifestPath = artifactEntryPath(baseArtifacts, "manifest");
    if (manifestPath) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
        const generatedFiles = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles : [];
        const closureName = path.basename(path.resolve(closurePath));
        baseManifestUnchanged = !generatedFiles.some(value => isRecord(value) && (value.path === closureName || value.path === path.resolve(closurePath)));
        if (!baseManifestUnchanged) failures.push("circular-manifest-reference");
      } catch (error) {
        failures.push(`manifest-read:${String(error)}`);
      }
    } else {
      failures.push("manifest-binding");
    }

    return {
      valid: failures.length === 0,
      selfHashMatched,
      boundFilesMatched,
      baseManifestUnchanged,
      failures
    };
  }

  private async assertNotCircular(outputPath: string, manifestPath: string): Promise<void> {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const generatedFiles = Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles : [];
    const outputName = path.basename(outputPath);
    if (outputPath === path.resolve(manifestPath) || generatedFiles.some(value => isRecord(value) && (value.path === outputName || value.path === outputPath))) {
      throw new Error("AcceptanceClosureCircularReference: detached closure must not be referenced by the canonical manifest");
    }
  }

  private jobDirectory(jobId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(jobId)) throw new Error(`Unsafe jobId for acceptance closure: ${jobId}`);
    return path.join(path.resolve(this.options.rootDirectory), jobId);
  }
}

async function hashFiles(paths: Record<string, string>): Promise<Record<string, { path: string; sha256: string; size: number }>> {
  const entries: Record<string, { path: string; sha256: string; size: number }> = {};
  for (const [name, filePath] of Object.entries(paths)) entries[name] = { path: filePath, ...(await fileInfo(filePath)) };
  return entries;
}

function artifactPaths(value: unknown): Array<{ path: string; sha256: string; size: number }> {
  if (!isRecord(value)) return [];
  return Object.values(value).filter((entry): entry is { path: string; sha256: string; size: number } =>
    isRecord(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string" && typeof entry.size === "number"
  );
}

function artifactEntryPath(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return isRecord(entry) && typeof entry.path === "string" ? entry.path : undefined;
}

async function requireFile(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Acceptance closure input is not a file: ${filePath}`);
}

async function fileInfo(filePath: string): Promise<{ size: number; sha256: string }> {
  const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  return { size: metadata.size, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

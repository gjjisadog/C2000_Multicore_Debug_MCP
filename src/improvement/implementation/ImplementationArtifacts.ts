import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DebugMcpError } from "../../utils/errors.js";
import { implementationArtifactSchema, type ImplementationArtifact } from "./ImplementationSchemas.js";

export class ImprovementArtifactWriter {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory);
  }

  async write(runId: string, kind: ImplementationArtifact["kind"], relativeName: string, content: string): Promise<ImplementationArtifact> {
    const safeName = relativeName.replace(/\\/g, "/").replace(/^\/+/, "");
    const artifactPath = path.resolve(this.rootDirectory, runId, safeName);
    const relative = path.relative(path.resolve(this.rootDirectory), artifactPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new DebugMcpError("WorkspaceBoundaryViolation", "Improvement artifact path escapes the configured artifact root", {
        artifactRoot: this.rootDirectory,
        artifactPath
      });
    }
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, content, "utf8");
    const metadata = await stat(artifactPath);
    return implementationArtifactSchema.parse({
      kind,
      path: artifactPath,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      bytes: metadata.size
    });
  }

  async writeJson(runId: string, kind: ImplementationArtifact["kind"], relativeName: string, value: unknown): Promise<ImplementationArtifact> {
    return this.write(runId, kind, relativeName, `${JSON.stringify(value, null, 2)}\n`);
  }
}

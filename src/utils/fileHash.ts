import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function fileMetadata(programUri: string) {
  // Artifact identity must be based on current bytes: size and mtime can stay
  // unchanged when a file is rewritten quickly, especially on Windows.
  const sha256 = await sha256File(programUri);
  const stats = await stat(programUri);
  return {
    fileMTime: stats.mtime.toISOString(),
    fileSize: stats.size,
    sha256
  };
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

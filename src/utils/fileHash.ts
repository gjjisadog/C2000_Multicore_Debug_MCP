import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function fileMetadata(programUri: string) {
  const stats = await stat(programUri);
  const sha256 = await sha256File(programUri);
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

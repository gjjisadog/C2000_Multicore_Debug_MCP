import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { sharedFileMetadataCache } from "./FileMetadataCache.js";

export async function fileMetadata(programUri: string) {
  const cached = await sharedFileMetadataCache.getOrCreate(programUri, () => sha256File(programUri));
  return {
    fileMTime: cached.fileMTime,
    fileSize: cached.fileSize,
    sha256: cached.value
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

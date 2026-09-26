import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { fileMetadata } from "../src/utils/fileHash.js";

describe("fileMetadata", () => {
  test("hashes current bytes after a same-size rewrite with unchanged mtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-file-hash-"));
    try {
      const file = path.join(directory, "cpu1.out");
      await writeFile(file, "cpu1-image-v1");
      const originalStats = await stat(file);
      const first = await fileMetadata(file);

      await writeFile(file, "cpu1-image-v2");
      await utimes(file, originalStats.atime, originalStats.mtime);
      const second = await fileMetadata(file);

      expect(second.fileSize).toBe(first.fileSize);
      expect(second.fileMTime).toBe(first.fileMTime);
      expect(second.sha256).not.toBe(first.sha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

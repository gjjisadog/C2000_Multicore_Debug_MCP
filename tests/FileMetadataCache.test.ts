import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMetadataCache } from "../src/utils/FileMetadataCache.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("FileMetadataCache", () => {
  it("reuses metadata until size or mtime changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "metadata-cache-")); roots.push(root);
    const file = path.join(root, "cpu1.out"); await writeFile(file, "one");
    const cache = new FileMetadataCache(); let calls = 0;
    await cache.getOrCreate(file, async () => ++calls);
    await cache.getOrCreate(file, async () => ++calls);
    expect({ calls, hits: cache.hits, misses: cache.misses }).toEqual({ calls: 1, hits: 1, misses: 1 });
    await writeFile(file, "changed-size");
    await cache.getOrCreate(file, async () => ++calls);
    expect(calls).toBe(2);
  });
});

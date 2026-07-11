import { stat } from "node:fs/promises";

export interface CachedFileMetadata<T> { fileMTime: string; fileSize: number; value: T; }

export class FileMetadataCache {
  private readonly entries = new Map<string, CachedFileMetadata<unknown>>();
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 128) {}

  async getOrCreate<T>(filePath: string, factory: () => Promise<T>): Promise<CachedFileMetadata<T>> {
    const stats = await stat(filePath);
    const fileMTime = stats.mtime.toISOString();
    const cached = this.entries.get(filePath) as CachedFileMetadata<T> | undefined;
    if (cached && cached.fileSize === stats.size && cached.fileMTime === fileMTime) {
      this.hits++;
      this.entries.delete(filePath);
      this.entries.set(filePath, cached);
      return cached;
    }
    this.misses++;
    const entry = { fileMTime, fileSize: stats.size, value: await factory() };
    this.entries.set(filePath, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return entry;
  }
}

export const sharedFileMetadataCache = new FileMetadataCache();

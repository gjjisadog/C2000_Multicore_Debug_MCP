import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export class AtomicArtifactWriter {
  async ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
  }

  async writeJson(filePath: string, value: unknown): Promise<void> {
    await this.writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeJsonLines(filePath: string, values: readonly unknown[]): Promise<void> {
    if (values.length === 0) return;
    await this.writeText(filePath, `${values.map(value => JSON.stringify(value)).join("\n")}\n`);
  }

  async writeText(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

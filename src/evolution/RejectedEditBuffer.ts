import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import {
  rejectedEditBufferSchema,
  rejectedEditSchema,
  type RejectedEdit,
  type RejectedEditBuffer as RejectedEditBufferDocument
} from "./EvolutionSchemas.js";

export class RejectedEditBuffer {
  private readonly writer: AtomicArtifactWriter;
  private readonly filePath: string;

  constructor(private readonly options: { rootDirectory: string; writer?: AtomicArtifactWriter }) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
    this.filePath = path.join(path.resolve(options.rootDirectory), "rejected-skill-edits.json");
  }

  async append(rawInput: Omit<RejectedEdit, "schemaVersion" | "rejectedEditId" | "createdAt"> & Partial<Pick<RejectedEdit, "rejectedEditId" | "createdAt">>): Promise<RejectedEdit> {
    const entry = rejectedEditSchema.parse({
      ...rawInput,
      schemaVersion: 1,
      rejectedEditId: rawInput.rejectedEditId ?? `rejected-${randomUUID()}`,
      createdAt: rawInput.createdAt ?? new Date().toISOString()
    });
    const buffer = await this.read();
    buffer.entries.push(entry);
    await this.writer.ensureDirectory(path.dirname(this.filePath));
    await this.writer.writeJson(this.filePath, buffer);
    return entry;
  }

  async list(skillName?: string): Promise<RejectedEdit[]> {
    const entries = (await this.read()).entries;
    return skillName ? entries.filter(entry => entry.skillName === skillName) : entries;
  }

  path(): string { return this.filePath; }

  private async read(): Promise<RejectedEditBufferDocument> {
    try {
      return rejectedEditBufferSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      return { schemaVersion: 1, entries: [] };
    }
  }
}

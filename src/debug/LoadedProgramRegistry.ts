import type { LoadedProgramInfo } from "./types.js";

export class LoadedProgramRegistry {
  private readonly programs = new Map<string, LoadedProgramInfo>();
  private readonly programmedPrograms = new Map<string, LoadedProgramInfo>();

  set(info: LoadedProgramInfo) {
    const key = this.key(info.sessionId, info.coreId);
    this.programs.set(key, info);
    if (info.targetMemoryWritten === true) {
      this.programmedPrograms.set(key, info);
    }
  }

  get(sessionId: string, coreId: number): LoadedProgramInfo | undefined {
    return this.programs.get(this.key(sessionId, coreId));
  }

  getProgrammed(sessionId: string, coreId: number): LoadedProgramInfo | undefined {
    return this.programmedPrograms.get(this.key(sessionId, coreId));
  }

  deleteSession(sessionId: string) {
    for (const key of this.programs.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.programs.delete(key);
      }
    }
    for (const key of this.programmedPrograms.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.programmedPrograms.delete(key);
      }
    }
  }

  private key(sessionId: string, coreId: number): string {
    return `${sessionId}:${coreId}`;
  }
}

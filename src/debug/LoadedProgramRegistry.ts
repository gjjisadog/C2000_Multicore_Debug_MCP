import type { LoadedProgramInfo } from "./types.js";

export class LoadedProgramRegistry {
  private readonly programs = new Map<string, LoadedProgramInfo>();

  set(info: LoadedProgramInfo) {
    this.programs.set(this.key(info.sessionId, info.coreId), info);
  }

  get(sessionId: string, coreId: number): LoadedProgramInfo | undefined {
    return this.programs.get(this.key(sessionId, coreId));
  }

  deleteSession(sessionId: string) {
    for (const key of this.programs.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.programs.delete(key);
      }
    }
  }

  private key(sessionId: string, coreId: number): string {
    return `${sessionId}:${coreId}`;
  }
}

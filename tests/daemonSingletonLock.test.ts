import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  acquireDaemonSingletonLock,
  daemonRuntimePaths
} from "../src/daemon/DaemonInstanceFile.js";

describe("daemon singleton lock", () => {
  test("allows only one live daemon owner per runtime directory", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "c2000-daemon-lock-"));
    try {
      const paths = daemonRuntimePaths(runtimeDir);
      const releaseFirst = await acquireDaemonSingletonLock(paths, "first");
      await expect(acquireDaemonSingletonLock(paths, "second")).rejects.toThrow(
        /already running/
      );
      await releaseFirst();

      const releaseSecond = await acquireDaemonSingletonLock(paths, "second");
      await releaseSecond();
    } finally {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });
});

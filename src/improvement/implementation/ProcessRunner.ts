import { spawn } from "node:child_process";

export interface ProcessRunRequest {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface ProcessRunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
}

/**
 * Run a configured executable without a shell. This is intentionally small:
 * Git, validation scripts, and the coding-agent adapter all share the same
 * timeout and bounded-output behavior.
 */
export function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  const args = [...(request.args ?? [])];
  const maxOutputBytes = Math.max(1024, Math.trunc(request.maxOutputBytes ?? 256 * 1024));
  const startedAt = Date.now();

  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const append = (current: string, chunk: Buffer | string): string => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const next = current + text;
      if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) return next;
      outputTruncated = true;
      return Buffer.from(next, "utf8").subarray(0, maxOutputBytes).toString("utf8");
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (spawnError) stderr = append(stderr, String(spawnError));
      resolve({
        command: request.command,
        args,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        outputTruncated,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    };

    let child;
    try {
      child = spawn(request.command, args, {
        cwd: request.cwd,
        env: request.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish(null, null, error);
      return;
    }

    child.stdout?.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(null, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1, Math.trunc(request.timeoutMs)));
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

export function processSucceeded(result: ProcessRunResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

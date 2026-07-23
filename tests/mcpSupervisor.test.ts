import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";

const supervisorPath = path.resolve("scripts/mcp-supervisor.mjs");

async function runSupervisor(args: string[]) {
  const child = spawn(process.execPath, [supervisorPath, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for supervisor output");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("MCP stdio supervisor", () => {
  test("restarts an unexpectedly failing child and keeps stdout free of diagnostics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-mcp-supervisor-restart-"));
    const counterPath = path.join(directory, "count.txt");
    const childPath = path.join(directory, "child.mjs");
    await writeFile(childPath, [
      'import { readFile, writeFile } from "node:fs/promises";',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const count = Number.parseInt(await readFile(counterPath, "utf8").catch(() => "0"), 10) + 1;',
      'await writeFile(counterPath, String(count));',
      'process.exit(count === 1 ? 1 : 0);'
    ].join("\n"));

    const result = await runSupervisor([
      "--initial-delay-ms", "1", "--max-delay-ms", "1", "--max-restarts", "2", "--",
      process.execPath, childPath
    ]);

    expect(result).toMatchObject({ code: 0, signal: null, stdout: "" });
    expect(result.stderr).toContain("restart 1/2");
    expect(await readFile(counterPath, "utf8")).toBe("2");
  });

  test("stops after the configured restart limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-mcp-supervisor-limit-"));
    const counterPath = path.join(directory, "count.txt");
    const childPath = path.join(directory, "child.mjs");
    await writeFile(childPath, [
      'import { readFile, writeFile } from "node:fs/promises";',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const count = Number.parseInt(await readFile(counterPath, "utf8").catch(() => "0"), 10) + 1;',
      'await writeFile(counterPath, String(count));',
      'process.exit(1);'
    ].join("\n"));

    const result = await runSupervisor([
      "--initial-delay-ms", "1", "--max-delay-ms", "1", "--max-restarts", "1", "--",
      process.execPath, childPath
    ]);

    expect(result).toMatchObject({ code: 1, signal: null });
    expect(result.stderr).toContain("restart limit reached");
    expect(await readFile(counterPath, "utf8")).toBe("2");
  });

  test("replays initialization after a server crash without replaying a tool request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-mcp-supervisor-handshake-"));
    const counterPath = path.join(directory, "count.txt");
    const childPath = path.join(directory, "child.mjs");
    await writeFile(childPath, [
      'import { createInterface } from "node:readline";',
      'import { readFile, writeFile } from "node:fs/promises";',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const count = Number.parseInt(await readFile(counterPath, "utf8").catch(() => "0"), 10) + 1;',
      'await writeFile(counterPath, String(count));',
      'const send = message => process.stdout.write(`${JSON.stringify(message)}\\n`);',
      'createInterface({ input: process.stdin }).on("line", line => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });',
      '  } else if (message.method === "notifications/initialized" && count === 1) {',
      '    setTimeout(() => process.exit(1), 10);',
      '  } else if (message.method === "tools/list") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });',
      '    setTimeout(() => process.exit(0), 10);',
      '  }',
      '});'
    ].join("\n"));

    const child = spawn(process.execPath, [
      supervisorPath, "--initial-delay-ms", "1", "--max-delay-ms", "1", "--max-restarts", "2", "--",
      process.execPath, childPath
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    await waitFor(() => stdout.includes('"id":1'));
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n');
    await waitFor(() => stderr.includes("replaying MCP initialize handshake"));
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    await waitFor(() => stdout.includes('"id":2'));
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];

    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect((stdout.match(/"id":1/g) ?? []).length).toBe(1);
    expect((stdout.match(/"id":2/g) ?? []).length).toBe(1);
    expect(await readFile(counterPath, "utf8")).toBe("2");
  });
});

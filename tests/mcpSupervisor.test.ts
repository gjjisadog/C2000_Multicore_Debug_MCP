import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  test("switches to an installed compatible runtime after the active request completes", async () => {
    const fixture = await hotSwapFixture(false);
    try {
      fixture.send(1, "initialize");
      await fixture.response(1);
      fixture.notify("notifications/initialized");
      fixture.send(2, "tools/call", { name: "echo", arguments: { delayMs: 300 } });
      await writeFile(fixture.pointerPath, JSON.stringify(fixture.pointerFor(2)));
      expect((await fixture.response(2)).result.version).toBe(1);
      await waitFor(() => fixture.stderr().includes("runtime switched with the existing MCP tool catalog"), 5000);
      fixture.send(3, "tools/call", { name: "echo", arguments: {} });
      expect((await fixture.response(3)).result.version).toBe(2);
      expect(fixture.stderr()).not.toContain("request outcome is unknown");
    } finally {
      await fixture.close();
    }
  }, 15000);

  test("keeps the old runtime when the installed tool catalog changes", async () => {
    const fixture = await hotSwapFixture(true);
    try {
      fixture.send(1, "initialize");
      await fixture.response(1);
      fixture.notify("notifications/initialized");
      fixture.send(2, "tools/list");
      await fixture.response(2);
      await writeFile(fixture.pointerPath, JSON.stringify(fixture.pointerFor(2)));
      await waitFor(() => fixture.stderr().includes("tool catalog changed"), 5000);
      await waitFor(() => fixture.stderr().includes("replaying MCP initialize handshake"), 5000);
      fixture.send(3, "tools/call", { name: "echo", arguments: {} });
      expect((await fixture.response(3)).result.version).toBe(1);
    } finally {
      await fixture.close();
    }
  }, 15000);

  test("restores the old runtime when the new process fails during startup", async () => {
    const fixture = await hotSwapFixture(false);
    try {
      fixture.send(1, "initialize");
      await fixture.response(1);
      fixture.notify("notifications/initialized");
      fixture.send(2, "tools/list");
      await fixture.response(2);
      await writeFile(fixture.entrypoints[1]!, "process.exit(1);\n");
      await writeFile(fixture.pointerPath, JSON.stringify(fixture.pointerFor(2)));
      await waitFor(() => fixture.stderr().includes("new runtime exited before its tool catalog was verified"), 5000);
      fixture.send(3, "tools/call", { name: "echo", arguments: {} });
      expect((await fixture.response(3)).result.version).toBe(1);
    } finally {
      await fixture.close();
    }
  }, 15000);

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

  test("recovers when the child exits before returning the initialize response", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "c2000-mcp-supervisor-pre-handshake-"));
    const counterPath = path.join(directory, "count.txt");
    const childPath = path.join(directory, "child.mjs");
    await writeFile(childPath, [
      'import { createInterface } from "node:readline";',
      'import { readFile, writeFile } from "node:fs/promises";',
      `const counterPath = ${JSON.stringify(counterPath)};`,
      'const count = Number.parseInt(await readFile(counterPath, "utf8").catch(() => "0"), 10) + 1;',
      'await writeFile(counterPath, String(count));',
      'const send = message => process.stdout.write(`${JSON.stringify(message)}\\n`);',
      'if (count === 1) setTimeout(() => process.exit(1), 20);',
      'createInterface({ input: process.stdin }).on("line", line => {',
      '  const message = JSON.parse(line);',
      '  if (count === 2 && message.method === "initialize") {',
      '    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });',
      '  } else if (count === 2 && message.method === "notifications/initialized") {',
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
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];

    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(stderr).toContain("resuming handshake");
    expect((stdout.match(/"id":1/g) ?? []).length).toBe(1);
    expect(await readFile(counterPath, "utf8")).toBe("2");
  });
});

async function hotSwapFixture(changedCatalog: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "c2000-mcp-supervisor-switch-"));
  const pointerPath = path.join(directory, "current.json");
  const entrypoints = [1, 2].map(version => path.join(directory, "versions", `v${version}`, "dist", "src", "index.mjs"));
  for (const [index, entrypoint] of entrypoints.entries()) {
    const version = index + 1;
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, [
      'import { createInterface } from "node:readline";',
      `const version = ${version};`,
      `const tools = [{ name: "echo", inputSchema: { type: "object" } }${changedCatalog && version === 2 ? ', { name: "new-tool", inputSchema: { type: "object" } }' : ''}];`,
      'const send = message => process.stdout.write(`${JSON.stringify(message)}\\n`);',
      'createInterface({ input: process.stdin }).on("line", async line => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: String(version) } } });',
      '  if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools } });',
      '  if (message.method === "tools/call") {',
      '    await new Promise(resolve => setTimeout(resolve, message.params.arguments?.delayMs ?? 0));',
      '    send({ jsonrpc: "2.0", id: message.id, result: { version } });',
      '  }',
      '});'
    ].join("\n"));
  }
  const pointerFor = (version: number) => ({
    installDirectory: path.dirname(path.dirname(path.dirname(entrypoints[version - 1]!))),
    entrypoint: entrypoints[version - 1],
    runtimeExecutable: process.execPath
  });
  await writeFile(pointerPath, JSON.stringify(pointerFor(1)));
  const child = spawn(process.execPath, [
    supervisorPath, "--current-pointer", pointerPath, "--pointer-poll-ms", "100",
    "--initial-delay-ms", "1", "--max-delay-ms", "1", "--",
    process.execPath, entrypoints[0]!
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const messages: any[] = [];
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => {
    output += chunk;
    const lines = output.split("\n");
    output = lines.pop() ?? "";
    for (const line of lines) if (line) messages.push(JSON.parse(line));
  });
  child.stderr.on("data", chunk => { errors += chunk; });
  return {
    pointerPath,
    entrypoints,
    pointerFor,
    stderr: () => errors,
    send: (id: number, method: string, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`),
    notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: {} })}\n`),
    response: async (id: number) => {
      await waitFor(() => messages.some(message => message.id === id), 5000);
      return messages.find(message => message.id === id);
    },
    close: async () => {
      child.stdin.end();
      await Promise.race([once(child, "close"), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SysConfigService } from "../src/sysconfig/SysConfigService.js";
import { inspectSysConfigSchema, updateSysConfigSchema } from "../src/sysconfig/SysConfigSchemas.js";
import { c2000McpConfigSchema } from "../src/config/config.schema.js";
import { c2000ToolDefinitions, createC2000ToolInvoker, definitionsForDynamicExposure } from "../src/mcp/tools.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { createC2000McpRuntimeSync } from "../src/server.js";
import { defaultF28P65xCoreMap } from "../src/debug/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const roots: string[] = [];
const cliPath = fileURLToPath(new URL("./fixtures/mockSysConfigCli.mjs", import.meta.url));
const ref = { moduleId: "/driverlib/gpio.js", moduleInstanceId: "LED1" };
const change = { ...ref, configurable: "direction", value: "GPIO_DIR_MODE_OUT" };
const digest = (source: string) => createHash("sha256").update(source).digest("hex");

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(source = "// Original configuration\n") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sysconfig-test-"));
  roots.push(directory);
  const syscfgPath = path.join(directory, "board config.syscfg");
  const productPath = path.join(directory, "sdk.json");
  await writeFile(syscfgPath, source);
  await writeFile(productPath, "{}");
  await writeFile(path.join(directory, "board.c"), "Existing generated source");
  const filesystem = { allowedReadRoots: [directory], allowedWriteRoots: [directory] };
  const service = new SysConfigService({ filesystem, config: { cliPath } });
  return { directory, syscfgPath, productPath, filesystem, service,
    update: { syscfgPath, productPath, changes: [change], expectedSha256: digest(source) } };
}

describe("SysConfig editing through the official engine boundary", () => {
  test("inspects runtime instances, defaults, choices and nested pins without changing sources", async () => {
    const f = await fixture();
    const result = await f.service.inspect({ syscfgPath: f.syscfgPath, productPath: f.productPath, instances: [ref] });
    expect(result).toMatchObject({ sha256: f.update.expectedSha256, requiresCcs: false,
      modules: [{ moduleId: ref.moduleId, instances: ["LED1", "LED2"] }],
      configuration: [{ ...ref, configuration: expect.arrayContaining([
        { id: "gpioPin.$assign", value: "GPIO12" },
        { id: "direction", value: "GPIO_DIR_MODE_IN", displayName: "Direction", choices: [{ name: "GPIO_DIR_MODE_IN" }, { name: "GPIO_DIR_MODE_OUT" }] }
      ]) }], validation: { passed: true, artifactsPublished: false, generatedFiles: ["board.c"] } });
    expect(await readFile(f.syscfgPath, "utf8")).toBe("// Original configuration\n");
    expect(await readFile(path.join(f.directory, "board.c"), "utf8")).toBe("Existing generated source");
  });

  test("previews by default, then saves only .syscfg atomically and returns the new hash", async () => {
    const f = await fixture();
    const preview = await f.service.update(f.update);
    expect(preview).toMatchObject({ saved: false, dryRun: true, sha256: f.update.expectedSha256, requiresRebuild: false });
    expect(await readFile(f.syscfgPath, "utf8")).not.toContain("GPIO_DIR_MODE_OUT");
    const saved = await f.service.update({ ...f.update, dryRun: false });
    expect(saved).toMatchObject({ saved: true, dryRun: false, requiresRebuild: true, sha256: preview.proposedSha256 });
    expect(saved.sha256).toBe(digest(await readFile(f.syscfgPath, "utf8")));
    const inspected = await f.service.inspect({ syscfgPath: f.syscfgPath, productPath: f.productPath, instances: [ref], configurableIds: ["direction"] });
    expect(inspected.configuration).toMatchObject([{ configuration: [{ id: "direction", value: "GPIO_DIR_MODE_OUT" }] }]);
    expect(await readFile(path.join(f.directory, "board.c"), "utf8")).toBe("Existing generated source");
    expect((await readdir(f.directory)).sort()).toEqual(["board config.syscfg", "board.c", "sdk.json"]);
  });

  test.each([
    { changes: [{ ...change, value: "NOT_A_REAL_DIRECTION" }], reason: /Invalid GPIO direction/ },
    { changes: [{ ...change, configurable: "gpioPin.$assign", value: "GPIO13" }], reason: /Pin conflict/ },
    { changes: [{ ...change, configurable: "doesNotExist", value: 1 }], reason: /Unknown configurable/ },
    { changes: [change, { ...change, moduleInstanceId: "MISSING" }], reason: /Unknown or ambiguous instance/ }
  ])("failed official validation leaves both configuration and generated code unchanged ($reason)", async ({ changes, reason }) => {
    const f = await fixture();
    await expect(f.service.update({ ...f.update, changes, dryRun: false })).rejects.toMatchObject({
      code: "SysConfigValidationFailed", details: { saved: false, stderr: expect.stringMatching(reason) }
    });
    expect(digest(await readFile(f.syscfgPath, "utf8"))).toBe(f.update.expectedSha256);
    expect(await readFile(path.join(f.directory, "board.c"), "utf8")).toBe("Existing generated source");
  });

  test("resolves batch targets before an instance rename and reopens its saved configuration", async () => {
    const f = await fixture();
    const renamed = { ...ref, moduleInstanceId: "RENAMED_LED" };
    const result = await f.service.update({ ...f.update, dryRun: false, changes: [{ ...change, configurable: "$name", value: renamed.moduleInstanceId }, change] });
    expect(result).toMatchObject({ saved: true, configuration: [{ ...renamed }] });
    const inspected = await f.service.inspect({ syscfgPath: f.syscfgPath, productPath: f.productPath, instances: [renamed], configurableIds: ["direction"] });
    expect(inspected).toMatchObject({ configuration: [{ ...renamed, configuration: [{ id: "direction", value: "GPIO_DIR_MODE_OUT" }] }] });
  });

  test("stale hashes, write denial and symlink escapes fail before any save", async () => {
    const f = await fixture();
    await expect(f.service.update({ ...f.update, expectedSha256: "0".repeat(64), dryRun: false })).rejects.toMatchObject({ code: "SysConfigConflict" });
    const denied = new SysConfigService({ filesystem: { ...f.filesystem, allowedWriteRoots: [] }, config: { cliPath } });
    await expect(denied.update(f.update)).rejects.toMatchObject({ code: "PathOutsideAllowedWriteRoots" });
    const outside = await mkdtemp(path.join(os.tmpdir(), "sysconfig-outside-")); roots.push(outside);
    await writeFile(path.join(outside, "outside.syscfg"), "// outside");
    await symlink(path.join(outside, "outside.syscfg"), path.join(f.directory, "linked.syscfg"));
    await expect(f.service.inspect({ syscfgPath: path.join(f.directory, "linked.syscfg"), productPath: f.productPath })).rejects.toMatchObject({ code: "PathOutsideAllowedReadRoots" });
    await expect(f.service.inspect({ syscfgPath: f.syscfgPath, productPath: path.join(outside, "sdk.json") })).rejects.toMatchObject({ code: "PathOutsideAllowedReadRoots" });
  });

  test("rejects concurrent edits and changes made during validation", async () => {
    const f = await fixture("// WAIT\n");
    const running = f.service.update({ ...f.update, dryRun: false });
    // A second call sees the lock after the first asynchronous path checks.
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(f.service.update(f.update)).rejects.toMatchObject({ code: "SysConfigBusy" });
    await writeFile(f.syscfgPath, "// external edit\n");
    await expect(running).rejects.toMatchObject({ code: "SysConfigConflict" });
    expect(await readFile(f.syscfgPath, "utf8")).toBe("// external edit\n");
    expect((await readdir(f.directory)).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  test("kills a timed out CLI and never saves", async () => {
    const f = await fixture("// WAIT\n");
    const service = new SysConfigService({ filesystem: f.filesystem, config: { cliPath, timeoutMs: 1000 } });
    await expect(service.update({ ...f.update, dryRun: false })).rejects.toMatchObject({ code: "SysConfigValidationFailed", details: { saved: false, timedOut: true } });
    expect(digest(await readFile(f.syscfgPath, "utf8"))).toBe(f.update.expectedSha256);
  });

  test("schemas prohibit arbitrary commands, prototype paths, generated sources and malformed values", async () => {
    const f = await fixture();
    for (const configurable of ["constructor.x", "__proto__.x", "gpioPin.__proto__", "direction;process.exit()", "$module.config"]) {
      expect(updateSysConfigSchema.safeParse({ ...f.update, changes: [{ ...change, configurable }] }).success).toBe(false);
    }
    expect(updateSysConfigSchema.safeParse({ ...f.update, command: "anything" }).success).toBe(false);
    expect(inspectSysConfigSchema.safeParse({ syscfgPath: f.syscfgPath, cliPath: "untrusted" }).success).toBe(false);
    await expect(f.service.inspect({ syscfgPath: path.join(f.directory, "board.c") })).rejects.toMatchObject({ code: "SysConfigInvalidInput" });
    expect(c2000McpConfigSchema.shape.sysconfig.parse({ cliPath })).toMatchObject({ timeoutMs: 60000 });
  });

  test("tools use structured handlers and expose writes only through allowed safety/capability profiles", async () => {
    const f = await fixture();
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const invoker = createC2000ToolInvoker(manager, { filesystem: f.filesystem, sysconfig: { cliPath } });
    const inspect = await invoker.invokeTool("c2000_inspectSysConfig", { syscfgPath: f.syscfgPath, productPath: f.productPath });
    expect(inspect).toMatchObject({ success: true, sha256: f.update.expectedSha256 });
    const failure = await invoker.invokeTool("c2000_updateSysConfig", { ...f.update, expectedSha256: "0".repeat(64) });
    expect(failure).toMatchObject({ success: false, error: { code: "SysConfigConflict" } });
    const readonly = definitionsForDynamicExposure("readonly", "agent", ["configuration.sysconfig"]);
    expect(readonly.some(tool => tool.name === "c2000_inspectSysConfig")).toBe(true);
    expect(readonly.some(tool => tool.name === "c2000_updateSysConfig")).toBe(false);
    const safe = definitionsForDynamicExposure("safe", "agent", ["configuration.sysconfig"]);
    expect(safe.filter(tool => tool.capability === "configuration.sysconfig")).toHaveLength(2);
    expect(c2000ToolDefinitions.find(tool => tool.name === "c2000_updateSysConfig")).toMatchObject({ approvalClass: "repository-write", annotations: { readOnlyHint: false }, effects: ["host-write", "repository-write"] });
    await manager.disposeAllSessions();
  });

  test("runtime config wires the CLI into MCP tools after capability discovery", async () => {
    const f = await fixture();
    const runtime = createC2000McpRuntimeSync(c2000McpConfigSchema.parse({
      adapter: "mock", target: { coreMap: defaultF28P65xCoreMap }, filesystem: f.filesystem,
      sysconfig: { cliPath }
    }));
    const client = new Client({ name: "sysconfig-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.some(tool => tool.name === "c2000_updateSysConfig")).toBe(false);
      const opened = await client.callTool({ name: "c2000_openCapabilitySession", arguments: { capability: "configuration.sysconfig", reason: "Update GPIO through the official configuration engine" } });
      expect(opened.isError).not.toBe(true);
      expect((await client.listTools()).tools.some(tool => tool.name === "c2000_updateSysConfig")).toBe(true);
      const inspected = await client.callTool({ name: "c2000_inspectSysConfig", arguments: { syscfgPath: f.syscfgPath, productPath: f.productPath } });
      expect(inspected.structuredContent).toMatchObject({ success: true, sha256: f.update.expectedSha256 });
      const updated = await client.callTool({ name: "c2000_updateSysConfig", arguments: { ...f.update, dryRun: false } });
      expect(updated.structuredContent).toMatchObject({ success: true, saved: true, requiresRebuild: true });
    } finally {
      await client.close();
      await runtime.dispose();
      await runtime.server.close();
    }
  });
});

test.skipIf(!process.env.C2000_SYSCONFIG_CLI || !process.env.C2000_SYSCONFIG_PRODUCT)("real TI F28P65x CLI validates edits, rejects invalid pins, and reloads the saved configuration", async () => {
  const f = await fixture(`const gpio = scripting.addModule("/driverlib/gpio.js", {}, false);\nconst led1 = gpio.addInstance(); led1.$name = "LED1"; led1.gpioPin.$assign = "GPIO12";\nconst led2 = gpio.addInstance(); led2.$name = "LED2"; led2.gpioPin.$assign = "GPIO13";\n`);
  const productPath = process.env.C2000_SYSCONFIG_PRODUCT!;
  const service = new SysConfigService({ filesystem: { ...f.filesystem, allowedReadRoots: [...f.filesystem.allowedReadRoots, path.dirname(productPath)] }, config: { cliPath: process.env.C2000_SYSCONFIG_CLI } });
  const input = { syscfgPath: f.syscfgPath, productPath, device: "F28P65x", package: "256ZEJ", part: "F28P65x_256ZEJ", context: "CPU1", instances: [ref] };
  const before = await service.inspect(input);
  expect(before.validation).toMatchObject({ passed: true });
  await expect(service.update({ ...input, expectedSha256: before.sha256 as string, changes: [{ ...change, configurable: "gpioPin.$assign", value: "GPIO13" }], dryRun: false })).rejects.toMatchObject({ code: "SysConfigValidationFailed" });
  await expect(service.update({ ...input, expectedSha256: before.sha256 as string, changes: [{ ...change, value: "INVALID_DIRECTION" }], dryRun: false })).rejects.toMatchObject({ code: "SysConfigValidationFailed" });
  const result = await service.update({ ...input, expectedSha256: before.sha256 as string, changes: [change], dryRun: false });
  expect(result).toMatchObject({ saved: true });
  const after = await service.inspect({ ...input, configurableIds: ["direction"] });
  expect(after).toMatchObject({ sha256: result.sha256, configuration: [{ configuration: [{ id: "direction", value: "GPIO_DIR_MODE_OUT" }] }] });
}, 30000);

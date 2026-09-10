import net from "node:net";
import { runInNewContext } from "node:vm";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  isRetryableXdsLaunchError,
  PersistentDssBridge,
  persistentServerScriptSource,
  type DssServerHandle,
  type DssServerLauncher,
  xdsRetryDelayMs
} from "../src/adapters/PersistentDssBridge.js";
import type { CcsBridgeCreateSessionOptions } from "../src/adapters/CcsScriptingBridge.js";
import { DebugMcpError } from "../src/utils/errors.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

const TEST_AUTH_TOKEN = "persistent-dss-unit-test-token";
const startedServers: net.Server[] = [];
const acceptedSockets: net.Socket[] = [];

describe("XDS launch retry policy", () => {
  test("only classifies transient XDS110 connection failures as probe-retryable", () => {
    expect(isRetryableXdsLaunchError(new DebugMcpError("DssLaunchFailed", "launch failed", {
      stderr: "Error -260 @ 0x0: An attempt to connect to the XDS110 failed"
    }))).toBe(true);
    expect(isRetryableXdsLaunchError(new Error("invalid ccxml"))).toBe(false);
  });

  test("uses capped exponential backoff", () => {
    expect([0, 1, 2, 3, 4].map(attempt => xdsRetryDelayMs(attempt))).toEqual([250, 500, 1000, 2000, 2000]);
  });
});

describe("PersistentDssBridge", () => {
  test("serializes bounded Java causes and frames from the generated DSS helper", () => {
    const source = persistentServerScriptSource("C:/ti/json2.js");
    const start = source.indexOf("function describeCommandException(");
    expect(start).toBeGreaterThan(0);
    const helper = source.slice(start, source.indexOf("function handleCommand("));
    const describe = (exception: unknown) => runInNewContext(
      helper + "describeCommandException(exception)", { exception });
    const cause = { toString: () => "Flash bank protected", getStackTrace: () => ["loader:42"],
      getCause: () => null };
    const result = describe({ javaException: { toString: () => "x".repeat(3000),
      getStackTrace: () => Array(20).fill("x".repeat(300)), getCause: () => cause } });
    expect(result.causes).toHaveLength(2);
    expect(result.causes[0].message).toHaveLength(2048);
    expect(result.causes[0].stack).toHaveLength(8);
    expect(result.causes[0].stack[0]).toHaveLength(256);
    expect(result.causes[1].message).toBe("Flash bank protected");
    const cycle = { toString: () => "cycle", getCause: (): unknown => cycle };
    expect(describe(cycle).causes).toHaveLength(1);
    const indirect = { toString: () => "cycle2", getCause: () => cycle };
    cycle.getCause = () => indirect;
    expect(describe(cycle).causes).toHaveLength(4);
    expect(describe("plain failure").causes[0].message).toBe("plain failure");
    expect(describe({ toString: () => "original", getCause: () => { throw Error("unavailable"); }
    }).causes[0].message).toBe("original");
    expect(source).toContain("details: describeCommandException(ex)");
  });

  test("preserves bounded redacted load failure evidence after disposal without retry", async () => {
    const received = new Map<number, unknown[]>();
    const server = await startJsonLineServer(command => command.name === "shutdown"
      ? { status: "OK", value: { shutdown: true } }
      : { status: "FAIL", message: "Load failed " + TEST_AUTH_TOKEN,
          details: { causes: [{ message: "Flash bank protected " + TEST_AUTH_TOKEN }] } }, received);
    let disposed = false;
    const output = { stdoutTail: "x".repeat(13000),
      stderrTail: "Flash failure " + TEST_AUTH_TOKEN, authToken: TEST_AUTH_TOKEN };
    const bridge = new PersistentDssBridge({ launcher: { async launch() {
      return { host: "127.0.0.1", portsByCoreId: new Map([[2, server.port]]),
        authToken: TEST_AUTH_TOKEN, diagnostics: () => output,
        dispose: async () => { disposed = true; output.stderrTail = "disposed"; } };
    } } });
    await bridge.createSession({ adapterSessionId: "failure-evidence", sessionName: "failure",
      ccxmlPath: "/tmp/target.ccxml", coreMap });
    let failure: DebugMcpError | undefined;
    try {
      await bridge.execute({ adapterSessionId: "failure-evidence", operation: "loadProgram",
        coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2",
        ccxmlPath: "/tmp/target.ccxml", programUri: "/tmp/cpu2.out" });
    } catch (error) { failure = error as DebugMcpError; }
    await bridge.disposeSession("failure-evidence");
    expect(disposed).toBe(true);
    expect(failure?.code).toBe("DssCommandFailed");
    expect(JSON.stringify(failure)).not.toContain(TEST_AUTH_TOKEN);
    expect(failure?.details).toMatchObject({ command: "loadProgram", coreId: 2,
      diagnostics: { stdoutTail: "x".repeat(12000), stdoutTailTruncated: true,
        stderrTail: "Flash failure [REDACTED]" },
      response: { details: { causes: [{ message: "Flash bank protected [REDACTED]" }] } } });
    expect(failure?.details.diagnostics).not.toHaveProperty("authToken");
    expect(received.get(server.port)).toEqual([
      expect.objectContaining({ name: "load", coreId: 2 }),
      expect.objectContaining({ name: "shutdown" })
    ]);
  });

  test.each([false, true])("diagnostics unavailable/throwing (%s) cannot hide load failure", async throws => {
    const server = await startJsonLineServer(command => command.name === "shutdown"
      ? { status: "OK", value: {} } : { status: "FAIL", message: "original load failure" }, new Map());
    const bridge = new PersistentDssBridge({ launcher: { async launch() {
      return { host: "127.0.0.1", portsByCoreId: new Map([[2, server.port]]),
        authToken: TEST_AUTH_TOKEN, dispose: async () => {},
        ...(throws ? { diagnostics: () => { throw Error("diagnostics failed"); } } : {}) };
    } } });
    await bridge.createSession({ adapterSessionId: "missing-evidence", sessionName: "failure",
      ccxmlPath: "/tmp/target.ccxml", coreMap });
    try {
      await expect(bridge.execute({ adapterSessionId: "missing-evidence", operation: "loadProgram",
        coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2",
        programUri: "/tmp/cpu2.out" })).rejects.toMatchObject({ code: "DssCommandFailed",
          message: "original load failure", details: {
            diagnostics: throws ? { captureFailed: true } : {}
          } });
    } finally { await bridge.disposeSession("missing-evidence"); }
  });

  test("successful commands do not collect failure diagnostics", async () => {
    let captures = 0;
    const server = await startJsonLineServer(command => ({ status: "OK", value: {
      coreId: command.coreId, coreName: command.coreName, state: "Running" } }), new Map());
    const bridge = new PersistentDssBridge({ launcher: { async launch() {
      return { host: "127.0.0.1", portsByCoreId: new Map([[2, server.port]]),
        authToken: TEST_AUTH_TOKEN, dispose: async () => {},
        diagnostics: () => { captures++; return {}; } };
    } } });
    await bridge.createSession({ adapterSessionId: "success-evidence", sessionName: "success",
      ccxmlPath: "/tmp/target.ccxml", coreMap });
    try {
      await bridge.execute({ adapterSessionId: "success-evidence", operation: "run",
        coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" });
      expect(captures).toBe(0);
    } finally { await bridge.disposeSession("success-evidence"); }
  });

  afterEach(async () => {
    for (const socket of acceptedSockets.splice(0)) socket.destroy();
    await Promise.all(startedServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  test("keeps failures observable while suppressing success chatter for bounded polling batches", () => {
    const source = persistentServerScriptSource("C:/ti/json2.js");
    expect(source).toContain('if (command.diagnostics !== "errors-only")');
    expect(source).toContain('logDiagnostic("command:failure"');
  });

  test("routes commands to the socket assigned to the requested core", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu1 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu1", coreId: command.coreId, coreName: command.coreName, command } }), receivedByPort);
    const cpu2 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu2", coreId: command.coreId, coreName: command.coreName, command } }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[0, cpu1.port], [2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-1",
      sessionName: "route-test",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    const result = await bridge.execute({
      adapterSessionId: "ccs-session-1",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    });
    await bridge.execute({
      adapterSessionId: "ccs-session-1",
      operation: "loadSymbols",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2",
      programUri: "/tmp/cpu2.out"
    });

    expect(result).toEqual(expect.objectContaining({ core: "cpu2" }));
    expect(receivedByPort.get(cpu1.port) ?? []).toHaveLength(0);
    expect(receivedByPort.get(cpu2.port)).toEqual([
      expect.objectContaining({ name: "runAsynch", coreId: 2, coreName: "C28xx_CPU2", authToken: TEST_AUTH_TOKEN }),
      expect.objectContaining({ name: "loadSymbols", coreId: 2, coreName: "C28xx_CPU2", program: "/tmp/cpu2.out", authToken: TEST_AUTH_TOKEN })
    ]);
  });

  test("routes expression assignment to the requested core socket", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu1 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu1", coreId: command.coreId, coreName: command.coreName, command } }), receivedByPort);
    const cpu2 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu2", coreId: command.coreId, coreName: command.coreName, command } }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[0, cpu1.port], [2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-assign",
      sessionName: "assign-test",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    const result = await bridge.execute({
      adapterSessionId: "ccs-session-assign",
      operation: "assignExpression",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2",
      expression: "g_ulHybrid30kIpcPass",
      valueExpression: "0"
    });

    expect(result).toEqual(expect.objectContaining({ core: "cpu2" }));
    expect(receivedByPort.get(cpu1.port) ?? []).toHaveLength(0);
    expect(receivedByPort.get(cpu2.port)).toEqual([
      expect.objectContaining({
        name: "assignExpression",
        coreId: 2,
        coreName: "C28xx_CPU2",
        expression: "g_ulHybrid30kIpcPass",
        valueExpression: "0"
      })
    ]);
  });

  test("routes explicit memory writes to the requested core socket", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu1 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu1", coreId: command.coreId, coreName: command.coreName, command } }), receivedByPort);
    const cpu2 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu2", coreId: command.coreId, coreName: command.coreName, command } }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[0, cpu1.port], [2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-write-memory",
      sessionName: "write-memory-test",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    const result = await bridge.execute({
      adapterSessionId: "ccs-session-write-memory",
      operation: "writeMemory",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 0,
      coreName: "C28xx_CPU1",
      corePattern: "C28xx_CPU1",
      page: "DATA",
      address: 0x0005F444,
      value: 0x10,
      typeSize: 32
    });

    expect(result).toEqual(expect.objectContaining({ core: "cpu1" }));
    expect(receivedByPort.get(cpu2.port) ?? []).toHaveLength(0);
    expect(receivedByPort.get(cpu1.port)).toEqual([
      expect.objectContaining({
        name: "writeData",
        coreId: 0,
        coreName: "C28xx_CPU1",
        page: "DATA",
        address: 0x0005F444,
        value: 0x10,
        typeSize: 32
      })
    ]);
  });

  test("rejects a DSS response whose core identity does not match the requested core", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu2 = await startJsonLineServer(command => ({
      status: "OK",
      value: { coreId: 0, coreName: "C28xx_CPU1", command }
    }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-wrong-response-core",
      sessionName: "wrong-response-core",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-wrong-response-core",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "CoreIdentityMismatch",
      details: expect.objectContaining({
        requestedCoreId: 2,
        responseCoreId: 0
      })
    });
  });

  test("rejects a successful DSS response that omits core identity", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu2 = await startJsonLineServer(command => ({
      status: "OK",
      value: { state: "Running", command }
    }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-missing-response-core",
      sessionName: "missing-response-core",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-missing-response-core",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "CoreIdentityMissing",
      details: expect.objectContaining({
        requestedCoreId: 2,
        requestedCoreName: "C28xx_CPU2"
      })
    });
  });

  test("rejects a successful DSS response with a non-string coreName identity", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu2 = await startJsonLineServer(command => ({
      status: "OK",
      value: { coreId: command.coreId, coreName: 2, command }
    }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-non-string-response-core-name",
      sessionName: "non-string-response-core-name",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-non-string-response-core-name",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "CoreIdentityMismatch",
      details: expect.objectContaining({
        requestedCoreName: "C28xx_CPU2",
        responseCoreName: 2
      })
    });
  });

  test("rejects a successful DSS response with a non-number coreId identity", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu2 = await startJsonLineServer(command => ({
      status: "OK",
      value: { coreId: "2", coreName: command.coreName, command }
    }), receivedByPort);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-non-number-response-core-id",
      sessionName: "non-number-response-core-id",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-non-number-response-core-id",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "CoreIdentityMismatch",
      details: expect.objectContaining({
        requestedCoreId: 2,
        responseCoreId: "2"
      })
    });
  });

  test("throws CoreNotFound when a command targets a core without a persistent session port", async () => {
    const launcher: DssServerLauncher = {
      async launch(): Promise<DssServerHandle> {
        return { host: "127.0.0.1", authToken: TEST_AUTH_TOKEN, portsByCoreId: new Map([[0, 12345]]), dispose: async () => {} };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-2",
      sessionName: "missing-core",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-2",
      operation: "halt",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({ code: "CoreNotFound" });
  });

  test("wraps malformed DSS socket responses as structured adapter errors", async () => {
    const cpu2 = await startRawLineServer("not-json");
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher });
    await bridge.createSession({
      adapterSessionId: "ccs-session-malformed-json",
      sessionName: "malformed-json",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-malformed-json",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "PersistentChannelReconnectFailed",
      details: expect.objectContaining({
        host: "127.0.0.1",
        port: cpu2.port,
        secondError: expect.stringContaining("SyntaxError")
      })
    });
  });

  test("wraps DSS socket connection failures as structured adapter errors", async () => {
    const closedPort = await reserveAndClosePort();
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, closedPort]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher, timeoutMs: 500 });
    await bridge.createSession({
      adapterSessionId: "ccs-session-connection-refused",
      sessionName: "connection-refused",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-connection-refused",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "PersistentChannelReconnectFailed",
      details: expect.objectContaining({
        host: "127.0.0.1",
        port: closedPort
      })
    });
  });

  test("wraps DSS socket close before a full JSON line as structured adapter errors", async () => {
    const cpu2 = await startEarlyCloseServer();
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher, timeoutMs: 500 });
    await bridge.createSession({
      adapterSessionId: "ccs-session-early-close",
      sessionName: "early-close",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-early-close",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "PersistentChannelReconnectFailed",
      details: expect.objectContaining({
        host: "127.0.0.1",
        port: cpu2.port,
        secondError: expect.stringContaining("PersistentChannelDisconnected")
      })
    });
  });

  test("includes partial DSS socket responses in timeout adapter errors", async () => {
    const partialResponse = "{\"status\":\"OK\"";
    const cpu2 = await startPartialNoNewlineServer(partialResponse);
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher, timeoutMs: 50 });
    await bridge.createSession({
      adapterSessionId: "ccs-session-partial-timeout",
      sessionName: "partial-timeout",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-partial-timeout",
      operation: "run",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2"
    })).rejects.toMatchObject({
      code: "PersistentChannelReconnectFailed",
      details: expect.objectContaining({
        host: "127.0.0.1",
        port: cpu2.port,
        firstError: expect.stringContaining("DssCommandTimeout")
      })
    });
  });

  test("includes requested command and core context in timeout adapter errors", async () => {
    const cpu2 = await startPartialNoNewlineServer("");
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher, timeoutMs: 50 });
    await bridge.createSession({
      adapterSessionId: "ccs-session-timeout-context",
      sessionName: "timeout-context",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-timeout-context",
      operation: "loadProgram",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2",
      programUri: "/tmp/cpu2.out"
    })).rejects.toMatchObject({
      code: "PersistentChannelReconnectFailed",
      details: expect.objectContaining({
        adapterSessionId: "ccs-session-timeout-context",
        coreId: 2,
        coreName: "C28xx_CPU2",
        host: "127.0.0.1",
        port: cpu2.port,
        firstError: expect.stringContaining("DssCommandTimeout")
      })
    });
  });

  test("includes persistent DSS process diagnostics in timeout adapter errors", async () => {
    const cpu2 = await startPartialNoNewlineServer("");
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[2, cpu2.port]]),
          diagnostics: () => ({
            pid: 4321,
            exitCode: null,
            signalCode: null,
            stdoutTail: "C2000_DSS_SERVER_READY",
            stderrTail: "C2000_DSS_SERVER_EVENT {\"event\":\"command:start\",\"coreId\":2,\"command\":\"load\"}"
          }),
          dispose: async () => {}
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher, timeoutMs: 50 });
    await bridge.createSession({
      adapterSessionId: "ccs-session-timeout-diagnostics",
      sessionName: "timeout-diagnostics",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await expect(bridge.execute({
      adapterSessionId: "ccs-session-timeout-diagnostics",
      operation: "loadProgram",
      ccxmlPath: "/tmp/target.ccxml",
      coreId: 2,
      coreName: "C28xx_CPU2",
      corePattern: "C28xx_CPU2",
      programUri: "/tmp/cpu2.out"
    })).rejects.toMatchObject({
      code: "PersistentChannelReconnectFailed",
      details: expect.objectContaining({
        diagnostics: expect.objectContaining({
          pid: 4321,
          stdoutTail: "C2000_DSS_SERVER_READY",
          stderrTail: expect.stringContaining("command:start")
        })
      })
    });
  });

  test("sends shutdown to the first core socket before disposing a persistent session", async () => {
    const receivedByPort = new Map<number, unknown[]>();
    const cpu1 = await startJsonLineServer(command => ({ status: "OK", value: { shutdown: command.name === "shutdown" } }), receivedByPort);
    const cpu2 = await startJsonLineServer(command => ({ status: "OK", value: { core: "cpu2", command } }), receivedByPort);
    let disposed = false;
    const launcher: DssServerLauncher = {
      async launch(_options: CcsBridgeCreateSessionOptions): Promise<DssServerHandle> {
        return {
          host: "127.0.0.1",
          authToken: TEST_AUTH_TOKEN,
          portsByCoreId: new Map([[0, cpu1.port], [2, cpu2.port]]),
          dispose: async () => {
            disposed = true;
          }
        };
      }
    };
    const bridge = new PersistentDssBridge({ launcher, timeoutMs: 500 });
    await bridge.createSession({
      adapterSessionId: "ccs-session-shutdown",
      sessionName: "shutdown-test",
      ccxmlPath: "/tmp/target.ccxml",
      coreMap
    });

    await bridge.disposeSession("ccs-session-shutdown");

    expect(receivedByPort.get(cpu1.port)).toEqual([
      expect.objectContaining({ name: "shutdown", authToken: TEST_AUTH_TOKEN })
    ]);
    expect(receivedByPort.get(cpu2.port) ?? []).toHaveLength(0);
    expect(disposed).toBe(true);
  });

  test("terminates the session-owned DSS process group and its descendants", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-dss-process-group-"));
    const dssScriptPath = path.join(tempDir, "fake-dss.sh");
    const adapterSessionId = "ccs-session-process-group";
    await writeFile(dssScriptPath, [
      "#!/bin/sh",
      "set -eu",
      "child_pid_file=\"$0.child.pid\"",
      "sleep 60 &",
      "child_pid=$!",
      "printf '%s\\n' \"$child_pid\" > \"$child_pid_file\"",
      "printf 'C2000_DSS_SERVER_READY\\n'",
      "trap 'kill \"$child_pid\" 2>/dev/null || true; exit 0' TERM INT EXIT",
      "wait \"$child_pid\""
    ].join("\n"), "utf8");
    await chmod(dssScriptPath, 0o755);

    const bridge = new PersistentDssBridge({
      ccsInstallPath: tempDir,
      dssScriptPath,
      startupMs: 1000,
      timeoutMs: 100,
      shutdownRequestMs: 20,
      processExitMs: 100
    });
    try {
      await bridge.createSession({
        adapterSessionId,
        sessionName: "process-group-test",
        ccxmlPath: path.join(tempDir, "target.ccxml"),
        coreMap: [coreMap[0]]
      });

      const diagnostics = bridge.ownedProcesses()[0];
      expect(diagnostics.processGroupId).toBe(diagnostics.pid);
      const childPid = Number(await waitForTextFile(`${dssScriptPath}.child.pid`));
      expect(childPid).toBeGreaterThan(0);

      await bridge.disposeSession(adapterSessionId);
      await waitForProcessExit(childPid);
      expect(bridge.ownedProcesses()).toEqual([]);
    } finally {
      await bridge.disposeAllSessions();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForTextFile(filePath: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return (await readFile(filePath, "utf8")).trim();
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(10);
  }
  throw new Error(`Process ${pid} did not exit`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startJsonLineServer(
  respond: (command: any) => unknown,
  receivedByPort: Map<number, unknown[]>
): Promise<{ port: number }> {
  const server = net.createServer(socket => {
    acceptedSockets.push(socket);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (let newlineIndex = buffer.indexOf("\n"); newlineIndex >= 0; newlineIndex = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const command = JSON.parse(line);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const received = receivedByPort.get(port) ?? [];
        received.push(command);
        receivedByPort.set(port, received);
        socket.write(`${JSON.stringify(respond(command))}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  startedServers.push(server);
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("server did not bind to a TCP port");
  }
  return { port: address.port };
}

async function startRawLineServer(responseLine: string): Promise<{ port: number }> {
  const server = net.createServer(socket => {
    acceptedSockets.push(socket);
    socket.on("data", () => {
      socket.write(`${responseLine}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  startedServers.push(server);
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("server did not bind to a TCP port");
  }
  return { port: address.port };
}

async function startEarlyCloseServer(): Promise<{ port: number }> {
  const server = net.createServer(socket => {
    acceptedSockets.push(socket);
    socket.on("data", () => {
      socket.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  startedServers.push(server);
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("server did not bind to a TCP port");
  }
  return { port: address.port };
}

async function startPartialNoNewlineServer(responsePrefix: string): Promise<{ port: number }> {
  const server = net.createServer(socket => {
    acceptedSockets.push(socket);
    socket.on("data", () => {
      socket.write(responsePrefix);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  startedServers.push(server);
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("server did not bind to a TCP port");
  }
  return { port: address.port };
}

async function reserveAndClosePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("server did not bind to a TCP port");
  }
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BoardLeaseContext } from "../src/boards/types.js";
import type { BoardWorkerSupervisor } from "../src/boards/BoardWorkerSupervisor.js";
import { c2000McpConfigSchema } from "../src/config/config.schema.js";
import { c2000ToolDefinitions } from "../src/mcp/tools.js";
import { DlogService } from "../src/observability/DlogService.js";
import { dlogBufferRequestSchema, dlogCaptureSchema } from "../src/observability/DlogSchemas.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { DebugMcpError } from "../src/utils/errors.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("read-only DLOG export", () => {
  it("exposes four readonly c2000 DLOG tools and no arm tool", () => {
    const names = c2000ToolDefinitions.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "c2000_describeDlogBuffer",
      "c2000_getDlogStatus",
      "c2000_readDlogBuffer",
      "c2000_exportDlog"
    ]));
    expect(names).not.toContain("c2000_armDlogCapture");
    const definitions = c2000ToolDefinitions.filter(tool => /Dlog/.test(tool.name));
    expect(definitions.every(tool =>
      tool.family === "observability" &&
      tool.coreIdentityFields?.includes("coreId") &&
      tool.responseCoreIdentityFields?.includes("coreName")
    )).toBe(true);
  });

  it("bounds sample count, channel count, and artifact size in the public schema", () => {
    expect(dlogBufferRequestSchema.safeParse(request({ sampleCount: 65_537 })).success).toBe(false);
    expect(dlogBufferRequestSchema.safeParse(request({
      channels: Array.from({ length: 33 }, (_, index) => ({
        name: `c${index}`, symbol: `g_c${index}`, type: "float32", unit: ""
      }))
    })).success).toBe(false);
    expect(dlogBufferRequestSchema.safeParse(request()).success).toBe(true);
  });

  it("rejects array-of-structures explicitly", async () => {
    const fixture = await createFixture();
    await expect(fixture.service.describe(request({ layout: "array-of-structures" })))
      .rejects.toMatchObject({ code: "UnsupportedLayout" });
    fixture.close();
  });

  it("freezes C28x 16-bit address units and per-element widths", async () => {
    const fixture = await createFixture();
    const described = await fixture.service.describe(request());
    expect(described).toMatchObject({ coreId: 0, coreName: "C28xx_CPU1", adapterSessionId: "adapter-a" });
    const descriptor = described.descriptor as any;
    expect(descriptor.targetAddressUnitBits).toBe(16);
    expect(descriptor.channels).toEqual([
      expect.objectContaining({
        name: "ia",
        resolvedAddress: "0x2000",
        elementWidthBits: 32,
        elementWidthOctets: 4,
        addressUnitsPerElement: 2,
        totalAddressUnits: 8
      }),
      expect.objectContaining({
        name: "flags",
        resolvedAddress: "0x3000",
        elementWidthBits: 16,
        elementWidthOctets: 2,
        addressUnitsPerElement: 1,
        totalAddressUnits: 4
      })
    ]);
    fixture.close();
  });

  it("normalizes decimal C28x addresses returned by real CCS", async () => {
    const fixture = await createFixture({ decimalAddresses: true });
    const described = await fixture.service.describe(request());
    expect((described.descriptor as any).channels).toEqual([
      expect.objectContaining({ name: "ia", resolvedAddress: "0x2000" }),
      expect.objectContaining({ name: "flags", resolvedAddress: "0x3000" })
    ]);
    fixture.close();
  });

  it("rejects a configured type when C28x sizeof does not match", async () => {
    const fixture = await createFixture({ wrongWidth: true });
    await expect(fixture.service.describe(request())).rejects.toMatchObject({ code: "DlogElementWidthMismatch" });
    fixture.close();
  });

  it("reads multiple channels and normalizes a full ring from next-write index", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.read(request());
    const capture = dlogCaptureSchema.parse(result.capture);
    expect(capture.normalizedOrder).toEqual([2, 3, 0, 1]);
    expect(capture.channels[0]!.values).toEqual([12, 13, 10, 11]);
    expect(capture.channels[1]!.values).toEqual([102, 103, 100, 101]);
    expect(capture.consistency.status).toBe("CONSISTENT");
    fixture.close();
  });

  it("orders pre-trigger, trigger, and post-trigger samples around triggerIndex", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.read(request({ preTriggerSamples: 1, postTriggerSamples: 2 }));
    const capture = dlogCaptureSchema.parse(result.capture);
    expect(capture.rawIndices.triggerIndex).toBe(3);
    expect(capture.normalizedOrder).toEqual([2, 3, 0, 1]);
    expect(capture.channels[0]!.values).toEqual([12, 13, 10, 11]);
    fixture.close();
  });

  it("retries when writeIndex changes during the first read", async () => {
    const fixture = await createFixture({ changeFirstWriteIndex: true });
    const result = await fixture.service.read(request({ maxReadRetries: 2 }));
    const capture = dlogCaptureSchema.parse(result.capture);
    expect(capture.captureCompleteness).toBe("COMPLETE");
    expect(fixture.worker.sampleBatchCalls).toBe(4);
    fixture.close();
  });

  it("marks a perpetually changing state as inconsistent and incomplete", async () => {
    const fixture = await createFixture({ alwaysChangeState: true });
    const result = await fixture.service.read(request({ maxReadRetries: 1 }));
    const capture = dlogCaptureSchema.parse(result.capture);
    expect(result.success).toBe(false);
    expect(capture.consistency).toMatchObject({ status: "INCONSISTENT", attempts: 2 });
    expect(capture.consistency.changedFields).toContain("state");
    expect(capture.captureCompleteness).toBe("INCOMPLETE");
    fixture.close();
  });

  it("atomically exports aligned CSV/JSON and standard evidence files", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.export(request());
    const directory = String(result.artifactDirectory);
    const capture = dlogCaptureSchema.parse(JSON.parse(await readFile(path.join(directory, "dlog.json"), "utf8")));
    const csv = (await readFile(path.join(directory, "dlog.csv"), "utf8")).trim().split("\n");
    expect(csv[0]).toBe("sampleIndex,relativeTimeSeconds,ia,flags");
    expect(csv[1]!.split(",").slice(2).map(Number)).toEqual([
      capture.channels[0]!.values[0],
      capture.channels[1]!.values[0]
    ]);
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    const artifactResult = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
    expect(manifest.completeness.status).toBe("COMPLETE");
    expect(artifactResult.overallStatus).toBe("COMPLETED");
    expect(await readFile(path.join(directory, "events.jsonl"), "utf8")).toContain("DLOG_READ_COMPLETED");
    expect(await readFile(path.join(directory, "summary.md"), "utf8")).toContain("declared sample rate");
    fixture.close();
  });

  it("records the configured sample-rate source and relative time only", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.read(request({ sampleRateHz: 32_000, sampleRateSource: "project-config" }));
    const capture = dlogCaptureSchema.parse(result.capture);
    expect(capture.sampleRateSource).toBe("project-config");
    expect(capture.sampleTimeBasis).toBe("configured-relative-time");
    expect(capture.relativeTimeSeconds[1]).toBeCloseTo(1 / 32_000);
    fixture.close();
  });

  it("rejects oversized buffers before reading samples", async () => {
    const fixture = await createFixture();
    await expect(fixture.service.read(request({ maxArtifactBytes: 10 })))
      .rejects.toMatchObject({ code: "DlogBufferTooLarge" });
    expect(fixture.worker.sampleBatchCalls).toBe(0);
    fixture.close();
  });

  it("fails closed for invalid symbols and CPU core mismatch", async () => {
    const invalid = await createFixture({ invalidSymbol: true });
    await expect(invalid.service.describe(request())).rejects.toMatchObject({ code: "DlogSymbolReadFailed" });
    invalid.close();
    const mismatch = await createFixture({ coreMismatch: true });
    await expect(mismatch.service.read(request())).rejects.toMatchObject({ code: "CoreIdentityMismatch" });
    mismatch.close();
  });

  it("terminates on lease expiry or worker generation change", async () => {
    const expired = await createFixture({ leaseFailureAfter: 2 });
    await expect(expired.service.read(request())).rejects.toMatchObject({ code: "LeaseExpired" });
    expired.close();
    const restarted = await createFixture({ restartDuringSamples: true });
    await expect(restarted.service.read(request())).rejects.toMatchObject({ code: "WorkerGenerationChanged" });
    restarted.close();
  });

  it("keeps Mock evidence separate from hardware evidence", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.read(request());
    expect((result.capture as any).evidenceClassification).toBe("MOCK");
    fixture.close();
  });

  it("provides deterministic target-side DLOG arrays in the real Mock adapter", async () => {
    const adapter = new MockDebugAdapter({
      dlogChannels: {
        "g_stDlog.afIa": { typeName: "float", address: "0x2000", values: [1.25, 2.5, 3.75] }
      }
    });
    const session = await adapter.createSession({
      sessionName: "mock-dlog",
      ccxmlPath: "mock.ccxml",
      coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }]
    });
    await adapter.connect(session, 0);
    const first = await adapter.evaluateExpressions(session, 0, [
      "&(g_stDlog.afIa)",
      "sizeof(g_stDlog.afIa[0])",
      "g_stDlog.afIa[1]"
    ]);
    const second = await adapter.evaluateExpressions(session, 0, ["g_stDlog.afIa[1]"]);
    expect(first.map(item => item.value)).toEqual(["0x2000", "2", "2.5"]);
    expect(second[0]?.value).toBe("2.5");
    await adapter.disposeSession(session);
  });
});

interface FixtureOptions {
  wrongWidth?: boolean;
  invalidSymbol?: boolean;
  coreMismatch?: boolean;
  changeFirstWriteIndex?: boolean;
  alwaysChangeState?: boolean;
  leaseFailureAfter?: number;
  restartDuringSamples?: boolean;
  decimalAddresses?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-dlog-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const boards = new BoardRepository(store);
  const sessions = new SessionRepository(store);
  boards.upsert({
    boardId: "board-a",
    probeSerial: "XDS110-A",
    device: "F28P65x",
    ccxmlPath: path.join(root, "board.ccxml"),
    tags: ["mock"]
  });
  sessions.upsert({
    sessionId: "session-a",
    boardId: "board-a",
    workerInstanceId: "worker-a",
    sessionName: "session-a",
    adapterSessionId: "adapter-a",
    coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }],
    status: "OPEN",
    createdAt: new Date().toISOString()
  });
  const lease: BoardLeaseContext = {
    leaseId: "lease-a",
    leaseToken: "secret-never-export",
    fencingToken: 9,
    leaseGeneration: 4,
    ownerJobId: "interactive-a",
    boardId: "board-a",
    probeSerial: "XDS110-A",
    workerInstanceId: "worker-a"
  };
  let leaseCalls = 0;
  const worker = new FakeDlogWorkers(options);
  const config = c2000McpConfigSchema.parse({
    adapter: "mock",
    ccs: { scriptingMode: "mock" },
    target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] }
  });
  const service = new DlogService({
    rootDirectory: path.join(root, "artifacts"),
    config,
    boards,
    sessions,
    workers: worker as unknown as BoardWorkerSupervisor,
    leaseContext: () => {
      leaseCalls += 1;
      if (options.leaseFailureAfter !== undefined && leaseCalls > options.leaseFailureAfter) {
        throw new DebugMcpError("LeaseExpired", "injected lease expiry");
      }
      return lease;
    }
  });
  return { root, store, sessions, worker, service, close: () => store.close() };
}

class FakeDlogWorkers {
  generation = 1;
  statusCalls = 0;
  sampleBatchCalls = 0;

  constructor(private readonly options: FixtureOptions) {}

  currentWorker() {
    return { workerInstanceId: "worker-a", workerGeneration: this.generation };
  }

  async invokeBoardLowPriority(_boardId: string, toolName: string, input: unknown) {
    if (toolName === "c2000_getSessionTopology") {
      return {
        success: true,
        boardId: "board-a",
        probeSerial: "XDS110-A",
        workerInstanceId: "worker-a",
        sessionId: "session-a",
        adapterSessionId: "adapter-a",
        cores: [{ coreId: 0, coreName: "C28xx_CPU1" }]
      };
    }
    const expressions = (input as Record<string, any>).expressions as string[];
    const metadata = expressions.some(expression => expression.startsWith("&(") || expression.startsWith("sizeof("));
    const status = expressions.includes("g_stDlog.uiState");
    if (status) this.statusCalls += 1;
    if (!metadata && !status) {
      this.sampleBatchCalls += 1;
      if (this.options.restartDuringSamples) this.generation += 1;
    }
    const results = expressions.map(expression => this.evaluate(expression));
    return {
      success: true,
      boardId: "board-a",
      probeSerial: "XDS110-A",
      workerInstanceId: "worker-a",
      sessionId: "session-a",
      adapterSessionId: "adapter-a",
      coreId: this.options.coreMismatch && !metadata ? 2 : 0,
      coreName: this.options.coreMismatch && !metadata ? "C28xx_CPU2" : "C28xx_CPU1",
      results
    };
  }

  private evaluate(expression: string) {
    if (this.options.invalidSymbol && expression === "&(g_stDlog.afIa)") {
      return { expression, success: false, error: { code: "SymbolNotFound", message: "injected" } };
    }
    const metadata: Record<string, string> = {
      "&(g_stDlog)": this.options.decimalAddresses ? "6144" : "0x1800",
      "&(g_stDlog.afIa)": this.options.decimalAddresses ? "8192" : "0x2000",
      "sizeof(g_stDlog.afIa[0])": this.options.wrongWidth ? "1" : "2",
      "&(g_stDlog.auFlags)": this.options.decimalAddresses ? "12288" : "0x3000",
      "sizeof(g_stDlog.auFlags[0])": "1"
    };
    if (metadata[expression]) return { expression, success: true, value: metadata[expression] };
    if (expression === "g_stDlog.uiState") {
      const value = this.options.alwaysChangeState ? this.statusCalls : 2;
      return { expression, success: true, value: String(value) };
    }
    if (expression === "g_stDlog.uiWriteIndex") {
      const value = this.options.changeFirstWriteIndex && this.statusCalls === 2 ? 3 : 2;
      return { expression, success: true, value: String(value) };
    }
    if (expression === "g_stDlog.uiTriggerIndex") return { expression, success: true, value: "3" };
    const index = Number(expression.match(/\[(\d+)\]$/)?.[1]);
    if (expression.startsWith("g_stDlog.afIa[")) return { expression, success: true, value: String(10 + index) };
    if (expression.startsWith("g_stDlog.auFlags[")) return { expression, success: true, value: String(100 + index) };
    return { expression, success: false, error: { code: "SymbolNotFound", message: expression } };
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    boardId: "board-a",
    sessionId: "session-a",
    coreId: 0,
    bufferSymbol: "g_stDlog",
    stateSymbol: "g_stDlog.uiState",
    writeIndexSymbol: "g_stDlog.uiWriteIndex",
    triggerIndexSymbol: "g_stDlog.uiTriggerIndex",
    sampleCount: 4,
    sampleRateHz: 32_000,
    sampleRateSource: "user-config",
    layout: "structure-of-arrays",
    channels: [
      { name: "ia", symbol: "g_stDlog.afIa", type: "float32", unit: "A" },
      { name: "flags", symbol: "g_stDlog.auFlags", type: "uint16", unit: "" }
    ],
    ...overrides
  };
}

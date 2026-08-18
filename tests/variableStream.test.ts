import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicArtifactWriter } from "../src/artifacts/AtomicArtifactWriter.js";
import type { BoardLeaseContext } from "../src/boards/types.js";
import type { BoardWorkerSupervisor } from "../src/boards/BoardWorkerSupervisor.js";
import { c2000McpConfigSchema } from "../src/config/config.schema.js";
import {
  VariableStreamService,
  classifyType
} from "../src/observability/VariableStreamService.js";
import { startVariableStreamSchema, VARIABLE_STREAM_INTERNAL_TOOL } from "../src/observability/VariableStreamSchemas.js";
import { claimPollSlot } from "../src/observability/pollSchedule.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { SessionRepository } from "../src/storage/repositories/SessionRepository.js";
import { VariableStreamRepository } from "../src/storage/repositories/VariableStreamRepository.js";
import { DebugMcpError } from "../src/utils/errors.js";
import { BoardWorkerRuntime } from "../src/worker/BoardWorkerRuntime.js";
import { c2000ToolDefinitions } from "../src/mcp/tools.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("slow variable stream contracts", () => {
  it("exposes the five c2000-prefixed observability tools with explicit core identity", () => {
    const names = [
      "c2000_startVariableStream",
      "c2000_stopVariableStream",
      "c2000_getVariableStreamStatus",
      "c2000_readVariableSamples",
      "c2000_exportVariableStream"
    ];
    const definitions = c2000ToolDefinitions.filter(tool => names.includes(tool.name));
    expect(definitions.map(tool => tool.name)).toEqual(names);
    expect(definitions.every(tool =>
      tool.family === "observability" &&
      tool.coreIdentityFields?.includes("coreId") &&
      tool.responseCoreIdentityFields?.includes("coreName")
    )).toBe(true);
  });

  it("enforces the software sampling and count limits", () => {
    expect(startVariableStreamSchema.safeParse(startInput({ samplePeriodMs: 9 })).success).toBe(false);
    expect(startVariableStreamSchema.safeParse(startInput({ variables: Array.from({ length: 33 }, (_, index) => `v${index}`) })).success).toBe(false);
    expect(startVariableStreamSchema.safeParse(startInput()).success).toBe(true);
    expect(startVariableStreamSchema.safeParse(startInput({
      variables: [{ symbol: "g_u16", typeName: "uint16_t" }]
    })).success).toBe(true);
  });

  it("models C28x 16-bit address units without ARM byte assumptions", () => {
    expect(classifyType("uint16_t")).toMatchObject({ byteWidth: 2, addressUnits: 1 });
    expect(classifyType("int32_t")).toMatchObject({ byteWidth: 4, addressUnits: 2 });
    expect(classifyType("float")).toMatchObject({ byteWidth: 4, addressUnits: 2 });
  });

  it("supports simple enums only with explicit signedness", () => {
    expect(() => classifyType("enum UiState")).toThrowError(/enumSignedness/);
    expect(classifyType("enum UiState", "unsigned")).toMatchObject({
      byteWidth: 2,
      addressUnits: 1,
      signedness: "unsigned",
      encoding: "enum"
    });
  });

  it("rejects unsupported variable types rather than guessing", () => {
    expect(() => classifyType("double")).toThrowError(/not supported/);
    expect(() => classifyType("struct Controller")).toThrowError(/not supported/);
  });

  it("freezes resolved symbol metadata and explicit CPU1 identity before polling", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ coreId: 0, coreName: "C28xx_CPU1", adapterSessionId: "adapter-a" });
    expect(terminal.metadata).toEqual([expect.objectContaining({
      symbol: "g_u16",
      resolvedAddress: "0x1000",
      typeName: "uint16_t",
      byteWidth: 2,
      addressUnits: 1,
      addressUnitBits: 16,
      coreId: 0,
      coreName: "C28xx_CPU1"
    })]);
    fixture.close();
  });

  it("normalizes decimal C28x addresses returned by real CCS", async () => {
    const fixture = await createFixture({ decimalAddress: true });
    const started = await fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal.metadata).toEqual([
      expect.objectContaining({ symbol: "g_u16", resolvedAddress: "0x1000" })
    ]);
    fixture.close();
  });

  it("fails closed when the requested core is not in the explicit session topology", async () => {
    const fixture = await createFixture();
    await expect(fixture.service.start(startInput({ coreId: 2 }))).rejects.toThrow(/absent/);
    fixture.close();
  });

  it("persists strictly increasing sequence and host monotonic timestamps", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.start(startInput({ maxSamples: 3, durationMs: 80 }));
    await fixture.waitTerminal(started);
    const samples = fixture.streams.allSamples(String(started.streamId));
    expect(samples.map(sample => sample.sequence)).toEqual([1, 2, 3]);
    expect(samples.every((sample, index) => index === 0 ||
      BigInt(sample.monotonicTimestampNs) > BigInt(samples[index - 1]!.monotonicTimestampNs))).toBe(true);
    expect(samples.every(sample => sample.targetSampleTime === null)).toBe(true);
    fixture.close();
  });

  it("reports actual host intervals without calling them MCU sample time", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.start(startInput({ maxSamples: 3, durationMs: 80 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal.stats.actualHostIntervalMs.last).toBeGreaterThan(0);
    expect(terminal.stats.actualHostIntervalMs.mean).toBeGreaterThan(0);
    fixture.close();
  });

  it("keeps polling deadlines anchored and does not accumulate execution-time drift", () => {
    const periodNs = 10_000_000n;
    let nextPollNs = 0n;
    const actualStarts = [0n, 7_000_000n, 23_000_000n, 31_000_000n, 47_000_000n];
    const claimed = actualStarts.map(actualStartNs => {
      const slot = claimPollSlot(actualStartNs, nextPollNs, periodNs);
      nextPollNs = slot.nextPollNs;
      return slot;
    });

    expect(claimed.map(slot => slot.scheduledStartNs)).toEqual([
      0n, 10_000_000n, 20_000_000n, 30_000_000n, 40_000_000n
    ]);
    expect(claimed.map(slot => slot.missedPollCount)).toEqual([0, 0, 0, 0, 0]);
    expect(nextPollNs).toBe(50_000_000n);
  });

  it("treats sub-period scheduler jitter separately from genuinely skipped poll slots", () => {
    expect(claimPollSlot(19_999_999n, 10_000_000n, 10_000_000n)).toMatchObject({
      scheduledStartNs: 10_000_000n,
      nextPollNs: 20_000_000n,
      missedPollCount: 0,
      schedulingLatenessNs: 9_999_999n
    });
    expect(claimPollSlot(20_000_000n, 10_000_000n, 10_000_000n)).toMatchObject({
      scheduledStartNs: 20_000_000n,
      nextPollNs: 30_000_000n,
      missedPollCount: 1,
      schedulingLatenessNs: 0n
    });
  });

  it("commits each sample and its stream checkpoint in one SQLite transaction", async () => {
    const fixture = await createFixture();
    const transaction = vi.spyOn(fixture.store, "transaction");
    const started = await fixture.service.start(startInput({ maxSamples: 3, durationMs: 80 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal.stats.totalSamples).toBe(3);
    expect(transaction).toHaveBeenCalledTimes(3);
    fixture.close();
  });

  it("counts overruns, missed polls, and dropped schedule slots", async () => {
    const fixture = await createFixture({ delayMs: 25 });
    const started = await fixture.service.start(startInput({ maxSamples: 2, durationMs: 100 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal.stats.overrunCount).toBeGreaterThan(0);
    expect(terminal.stats.missedPollCount).toBeGreaterThan(0);
    expect(terminal.stats.droppedSampleCount).toBeGreaterThan(0);
    fixture.close();
  });

  it("records per-variable read errors without inventing values", async () => {
    const fixture = await createFixture({ readErrorAt: 0 });
    const started = await fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }));
    const terminal = await fixture.waitTerminal(started);
    const [sample] = fixture.streams.allSamples(String(started.streamId));
    expect(terminal.stats.readErrorCount).toBe(1);
    expect(sample?.variables.g_u16).toMatchObject({ status: "ERROR", value: null });
    fixture.close();
  });

  it("makes stop idempotent", async () => {
    const fixture = await createFixture({ delayMs: 5 });
    const started = await fixture.service.start(startInput({ maxSamples: 100, durationMs: 1000 }));
    const identity = identityOf(started);
    const first = await fixture.service.stop(identity);
    const second = await fixture.service.stop(identity);
    expect(first.status).toBe("STOPPED");
    expect(second.status).toBe("STOPPED");
    fixture.close();
  });

  it("marks cancellation and its JSONL snapshot incomplete", async () => {
    const fixture = await createFixture({ delayMs: 5 });
    const started = await fixture.service.start(startInput({ maxSamples: 100, durationMs: 1000 }));
    const cancelled = await fixture.service.stop({ ...identityOf(started), cancel: true });
    const manifest = JSON.parse(await readFile(path.join(String(cancelled.artifactDirectory), "manifest.json"), "utf8"));
    expect(cancelled.status).toBe("CANCELLED");
    expect(manifest.completeness).toMatchObject({ status: "INCOMPLETE", reason: "CANCEL_REQUESTED" });
    fixture.close();
  });

  it("terminates immediately when the fencing lease expires", async () => {
    const fixture = await createFixture({ leaseFailureAfter: 1 });
    const started = await fixture.service.start(startInput({ maxSamples: 10, durationMs: 300 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ status: "FAILED", stopReason: "LeaseExpired" });
    fixture.close();
  });

  it("terminates when worker generation changes", async () => {
    const fixture = await createFixture({ delayMs: 5 });
    const started = await fixture.service.start(startInput({ maxSamples: 100, durationMs: 1000 }));
    fixture.worker.generation += 1;
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ status: "FAILED", stopReason: "WorkerGenerationChanged" });
    fixture.close();
  });

  it("terminates when the persisted session is invalidated", async () => {
    const fixture = await createFixture({ delayMs: 5 });
    const started = await fixture.service.start(startInput({ maxSamples: 100, durationMs: 1000 }));
    fixture.sessions.close("session-a");
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ status: "FAILED", stopReason: "SessionInvalidated" });
    fixture.close();
  });

  it("fails closed on a sample core identity mismatch", async () => {
    const fixture = await createFixture({ mismatchAfterMetadata: true });
    const started = await fixture.service.start(startInput({ maxSamples: 2, durationMs: 100 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ status: "FAILED", stopReason: "CoreIdentityMismatch" });
    fixture.close();
  });

  it("enforces the maximum portable variable artifact size", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.start(startInput({ maxSamples: 2, durationMs: 100, maxArtifactBytes: 1 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ status: "FAILED", stopReason: "VariableArtifactSizeLimit" });
    expect(terminal.stats.droppedSampleCount).toBe(1);
    fixture.close();
  });

  it("allows a high-priority board command to cancel the stream without waiting for export", async () => {
    const fixture = await createFixture({ delayMs: 20 });
    const started = await fixture.service.start(startInput({ maxSamples: 100, durationMs: 1000 }));
    await fixture.service.preemptBoard("board-a", "c2000_reset");
    const terminal = await fixture.waitTerminal(started);
    expect(terminal).toMatchObject({ status: "CANCELLED", stopReason: "PREEMPTED_BY:c2000_reset" });
    fixture.close();
  });

  it("never upgrades Mock samples to hardware evidence", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal.evidenceLevel).toBe("MOCK");
    const manifest = JSON.parse(await readFile(path.join(String(terminal.artifactDirectory), "manifest.json"), "utf8"));
    expect(manifest.evidenceLevel).toBe("MOCK");
    fixture.close();
  });

  it("does not persist lease or RPC secrets in portable artifacts", async () => {
    const fixture = await createFixture();
    const started = await fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }));
    const terminal = await fixture.waitTerminal(started);
    const files = await Promise.all(["manifest.json", "result.json", "events.jsonl", "summary.md", "variables.jsonl"].map(
      file => readFile(path.join(String(terminal.artifactDirectory), file), "utf8")
    ));
    expect(files.join("\n")).not.toContain("never-export-this-token");
    expect(files.join("\n")).not.toContain("lease-secret");
    fixture.close();
  });

  it("marks active streams interrupted on daemon restart and does not resume them", async () => {
    const fixture = await createFixture();
    const seed = streamRecord(fixture.root);
    fixture.streams.create(seed);
    await fixture.service.recoverInterrupted();
    expect(fixture.streams.get(seed.streamId)).toMatchObject({
      status: "INTERRUPTED",
      stopReason: "DAEMON_RESTART",
      artifactStatus: "EXPORTED"
    });
    fixture.close();
  });

  it("keeps the original stream result when artifact export fails", async () => {
    class FailingWriter extends AtomicArtifactWriter {
      override async writeText(): Promise<void> { throw new Error("artifact write failed"); }
    }
    const fixture = await createFixture({ writer: new FailingWriter() });
    const started = await fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }));
    const terminal = await fixture.waitTerminal(started);
    expect(terminal.status).toBe("COMPLETED");
    expect(terminal.artifactStatus).toBe("FAILED");
    expect(terminal.artifactError.message).toContain("artifact write failed");
    fixture.close();
  });

  it("limits a board to one active stream", async () => {
    const fixture = await createFixture({ delayMs: 10 });
    const started = await fixture.service.start(startInput({ maxSamples: 100, durationMs: 1000 }));
    await expect(fixture.service.start(startInput({ maxSamples: 1, durationMs: 50 }))).rejects.toThrow(/one active/);
    await fixture.service.stop(identityOf(started));
    fixture.close();
  });

  it("executes the internal bounded batch only inside a board worker and returns explicit core identity", async () => {
    const config = c2000McpConfigSchema.parse({
      adapter: "mock",
      ccs: { scriptingMode: "mock" },
      target: {
        name: "F28P65x",
        coreMap: [
          { coreId: 0, coreName: "C28xx_CPU1" },
          { coreId: 2, coreName: "C28xx_CPU2" }
        ]
      }
    });
    const runtime = new BoardWorkerRuntime({
      boardId: "board-a",
      probeSerial: "XDS110-A",
      ccxmlPath: "board-a.ccxml",
      workerInstanceId: "worker-a",
      daemonInstanceId: "daemon-a",
      authToken: "worker-rpc-only"
    }, config);
    const lease = {
      leaseId: "lease-a",
      leaseToken: "lease-secret",
      fencingToken: 1,
      leaseGeneration: 1,
      ownerJobId: "interactive-a",
      boardId: "board-a",
      probeSerial: "XDS110-A",
      workerInstanceId: "worker-a"
    };
    try {
      await runtime.start();
      const created = await runtime.invoke("create", "c2000_createDebugSession", {
        sessionName: "worker-variable-stream",
        __leaseContext: lease
      });
      const result = await runtime.invoke("read", VARIABLE_STREAM_INTERNAL_TOOL, {
        sessionId: created.sessionId,
        coreId: 0,
        expressions: ["g_stCtrl.uiState", "&(g_stCtrl.uiState)", "sizeof(g_stCtrl.uiState)"],
        timeoutMs: 100,
        __leaseContext: lease
      });
      expect(result).toEqual(expect.objectContaining({
        success: true,
        boardId: "board-a",
        workerInstanceId: "worker-a",
        sessionId: created.sessionId,
        adapterSessionId: expect.any(String),
        coreId: 0,
        coreName: "C28xx_CPU1"
      }));
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ expression: "&(g_stCtrl.uiState)", success: true, value: "0x1000" }),
        expect.objectContaining({ expression: "sizeof(g_stCtrl.uiState)", success: true, value: "1" })
      ]));
    } finally {
      await runtime.stop();
    }
  });
});

interface FixtureOptions {
  delayMs?: number;
  readErrorAt?: number;
  leaseFailureAfter?: number;
  mismatchAfterMetadata?: boolean;
  decimalAddress?: boolean;
  writer?: AtomicArtifactWriter;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2000-varstream-"));
  roots.push(root);
  const store = await SqliteStore.open(path.join(root, "runtime.sqlite"));
  const boards = new BoardRepository(store);
  const sessions = new SessionRepository(store);
  const streams = new VariableStreamRepository(store);
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
  const worker = new FakeWorkers(options);
  let leaseCalls = 0;
  const lease: BoardLeaseContext = {
    leaseId: "lease-a",
    leaseToken: "never-export-this-token",
    fencingToken: 7,
    leaseGeneration: 3,
    ownerJobId: "interactive-a",
    boardId: "board-a",
    probeSerial: "XDS110-A",
    workerInstanceId: "worker-a"
  };
  const config = c2000McpConfigSchema.parse({
    adapter: "mock",
    ccs: { scriptingMode: "mock" },
    target: { name: "F28P65x", coreMap: [{ coreId: 0, coreName: "C28xx_CPU1" }] }
  });
  const service = new VariableStreamService({
    rootDirectory: path.join(root, "artifacts"),
    config,
    streams,
    boards,
    sessions,
    workers: worker as unknown as BoardWorkerSupervisor,
    leaseContext: () => {
      leaseCalls += 1;
      if (options.leaseFailureAfter !== undefined && leaseCalls > options.leaseFailureAfter) {
        throw new DebugMcpError("LeaseExpired", "injected lease expiry");
      }
      return lease;
    },
    writer: options.writer
  });
  return {
    root,
    store,
    streams,
    sessions,
    worker,
    service,
    async waitTerminal(started: Record<string, unknown>) {
      const identity = identityOf(started);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const status = service.status(identity);
        if (["COMPLETED", "STOPPED", "CANCELLED", "INTERRUPTED", "FAILED"].includes(String(status.status)) &&
            status.artifactStatus !== "PENDING") return status as any;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error("stream did not become terminal");
    },
    close() { store.close(); }
  };
}

class FakeWorkers {
  generation = 1;
  private sampleIndex = 0;
  private metadataDone = false;

  constructor(private readonly options: FixtureOptions) {}

  currentWorker() {
    return { workerInstanceId: "worker-a", workerGeneration: this.generation };
  }

  async invokeBoardLowPriority(_boardId: string, toolName: string, input: unknown) {
    const values = input as Record<string, any>;
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
    const expressions = values.expressions as string[];
    const metadata = expressions.some(expression => expression.startsWith("sizeof("));
    if (!metadata && this.options.delayMs) await new Promise(resolve => setTimeout(resolve, this.options.delayMs));
    const results = expressions.map(expression => {
      if (expression === "&(g_u16)") {
        return { expression, success: true, value: this.options.decimalAddress ? "4096" : "0x1000", type: "uint16_t *" };
      }
      if (expression === "sizeof(g_u16)") return { expression, success: true, value: "1", type: "unsigned int" };
      if (!metadata && this.options.readErrorAt === this.sampleIndex) {
        return { expression, success: false, error: { code: "MockVariableReadError", message: "injected" } };
      }
      return { expression, success: true, value: String(this.sampleIndex), type: "uint16_t", address: "0x1000" };
    });
    if (!metadata) this.sampleIndex += 1;
    this.metadataDone ||= metadata;
    return {
      success: true,
      boardId: "board-a",
      probeSerial: "XDS110-A",
      workerInstanceId: "worker-a",
      sessionId: "session-a",
      adapterSessionId: "adapter-a",
      coreId: this.options.mismatchAfterMetadata && this.metadataDone && !metadata ? 2 : 0,
      coreName: this.options.mismatchAfterMetadata && this.metadataDone && !metadata ? "C28xx_CPU2" : "C28xx_CPU1",
      results
    };
  }
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    boardId: "board-a",
    sessionId: "session-a",
    coreId: 0,
    variables: ["g_u16"],
    samplePeriodMs: 10,
    durationMs: 100,
    maxSamples: 5,
    ...overrides
  };
}

function identityOf(value: Record<string, unknown>) {
  return {
    streamId: String(value.streamId),
    boardId: String(value.boardId),
    sessionId: String(value.sessionId),
    coreId: Number(value.coreId)
  };
}

function streamRecord(root: string) {
  return {
    streamId: "restart-stream",
    boardId: "board-a",
    sessionId: "session-a",
    adapterSessionId: "adapter-a",
    coreId: 0,
    coreName: "C28xx_CPU1",
    workerInstanceId: "worker-a",
    workerGeneration: 1,
    leaseId: "lease-a",
    leaseGeneration: 1,
    fencingToken: 1,
    config: { samplePeriodMs: 10, durationMs: 100, maxSamples: 10, maxArtifactBytes: 1024 },
    metadata: [],
    status: "RUNNING" as const,
    stats: {
      requestedSamplePeriodMs: 10,
      actualHostIntervalMs: { last: null, min: null, max: null, mean: null },
      missedPollCount: 0,
      overrunCount: 0,
      readErrorCount: 0,
      droppedSampleCount: 0,
      totalSamples: 0
    },
    startedAt: new Date().toISOString(),
    artifactDirectory: path.join(root, "artifacts", "restart-stream"),
    evidenceLevel: "MOCK" as const,
    artifactBytes: 0,
    artifactStatus: "PENDING" as const
  };
}

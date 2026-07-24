import { randomBytes, randomUUID } from "node:crypto";
import type { C2000McpConfig } from "../config/config.schema.js";
import type { WorkerHeartbeat } from "../worker/WorkerHeartbeat.js";
import { DebugMcpError } from "../utils/errors.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { WorkerRepository } from "../storage/repositories/WorkerRepository.js";
import { BoardRegistry } from "./BoardRegistry.js";
import type { BoardWorkerClient, BoardWorkerFactory } from "./BoardWorkerClient.js";
import { BoardWorkerProcess } from "./BoardWorkerProcess.js";
import { assertCcxmlProbeBinding } from "../hardware/ccxmlBinding.js";

interface ManagedWorker {
  client: BoardWorkerClient;
  restartTimes: number[];
}

/** Supervises independently restarted workers; no board may restart another board's worker. */
export class BoardWorkerSupervisor {
  private readonly workers = new Map<string, ManagedWorker>();
  private readonly factory: BoardWorkerFactory;
  private watchdog?: NodeJS.Timeout;

  constructor(
    private readonly options: {
      config: C2000McpConfig;
      daemonInstanceId: string;
      registry: BoardRegistry;
      workers: WorkerRepository;
      events: EventRepository;
      factory?: BoardWorkerFactory;
    }
  ) {
    this.factory = options.factory ?? ((launch, config) => new BoardWorkerProcess(launch, config));
  }

  async startAll(): Promise<void> {
    for (const board of this.options.registry.list()) {
      await this.startBoard(board.boardId);
    }
    this.watchdog ??= setInterval(() => { void this.checkHeartbeats(); }, this.workerConfig.heartbeatIntervalMs);
    this.watchdog.unref();
  }

  async startBoard(boardId: string): Promise<BoardWorkerClient> {
    const existing = this.workers.get(boardId)?.client;
    if (existing) return existing;
    const board = this.options.registry.get(boardId);
    if (this.requiresCcxmlProbeValidation) {
      await assertCcxmlProbeBinding(board.ccxmlPath, board.probeSerial);
    }
    this.options.registry.transition(boardId, "STARTING");
    const client = this.factory({
      boardId,
      probeSerial: board.probeSerial,
      ccxmlPath: board.ccxmlPath,
      workerInstanceId: `worker-${randomUUID()}`,
      daemonInstanceId: this.options.daemonInstanceId,
      authToken: randomBytes(32).toString("base64url")
    }, this.options.config);
    client.onHeartbeat = heartbeat => this.handleHeartbeat(heartbeat);
    const managed: ManagedWorker = { client, restartTimes: [] };
    this.workers.set(boardId, managed);
    try {
      await client.start();
      this.options.workers.upsert({
        workerInstanceId: client.workerInstanceId,
        boardId,
        pid: client.pid ?? -1,
        processStartTime: client.processStartTime,
        daemonInstanceId: this.options.daemonInstanceId,
        status: "READY",
        startedAt: client.processStartTime,
        ownedDssProcesses: []
      });
      this.options.registry.setWorker(boardId, client.workerInstanceId);
      this.options.registry.transition(boardId, "READY");
      this.options.events.append({ level: "info", sourceType: "worker", sourceId: client.workerInstanceId, boardId, workerInstanceId: client.workerInstanceId, eventType: "WORKER_STARTED", payload: { pid: client.pid, probeSerial: board.probeSerial } });
      return client;
    } catch (error) {
      this.workers.delete(boardId);
      this.options.registry.transition(boardId, "FAILED", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async invokeBoard(boardId: string, toolName: string, input: unknown, timeoutMs = this.workerConfig.defaultCommandTimeoutMs): Promise<Record<string, unknown>> {
    const worker = await this.startBoard(boardId);
    this.options.registry.transition(boardId, "RUNNING");
    try {
      const result = await worker.invokeTool(toolName, input, timeoutMs);
      this.assertResponseIdentity(boardId, worker, result);
      return result;
    } catch (error) {
      if (error instanceof DebugMcpError && error.code === "WorkerCommandTimeout") {
        await this.restartBoard(boardId, "command-timeout", error.details);
      }
      throw error;
    } finally {
      if (this.workers.get(boardId)?.client === worker) {
        this.options.registry.transition(boardId, "READY");
      }
    }
  }

  async restartBoard(boardId: string, reason: string, details: Record<string, unknown> = {}): Promise<void> {
    const managed = this.workers.get(boardId);
    const now = Date.now();
    const restartTimes = (managed?.restartTimes ?? []).filter(time => now - time <= this.workerConfig.restartWindowMs);
    if (restartTimes.length >= this.workerConfig.restartLimit) {
      this.options.registry.transition(boardId, "QUARANTINED", { code: "WorkerRestartLimitReached", reason, ...details });
      this.options.events.append({ level: "error", sourceType: "worker", sourceId: managed?.client.workerInstanceId ?? boardId, boardId, workerInstanceId: managed?.client.workerInstanceId, eventType: "WORKER_RESTART_LIMIT_REACHED", payload: { reason, ...details } });
      return;
    }
    restartTimes.push(now);
    if (managed) {
      this.workers.delete(boardId);
      await managed.client.stop(this.workerConfig.shutdownTimeoutMs).catch(() => undefined);
    }
    this.options.events.append({ level: "warn", sourceType: "worker", sourceId: managed?.client.workerInstanceId ?? boardId, boardId, workerInstanceId: managed?.client.workerInstanceId, eventType: "WORKER_RESTARTING", payload: { reason, ...details } });
    const client = await this.startBoard(boardId);
    const next = this.workers.get(boardId);
    if (next) next.restartTimes = restartTimes;
    this.options.events.append({ level: "info", sourceType: "worker", sourceId: client.workerInstanceId, boardId, workerInstanceId: client.workerInstanceId, eventType: "WORKER_RESTARTED", payload: { reason } });
  }

  async stopAll(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    const managed = Array.from(this.workers.values());
    this.workers.clear();
    await Promise.allSettled(managed.map(entry => entry.client.stop(this.workerConfig.shutdownTimeoutMs)));
  }

  private handleHeartbeat(heartbeat: WorkerHeartbeat): void {
    const managed = this.workers.get(heartbeat.boardId);
    if (!managed || managed.client.workerInstanceId !== heartbeat.workerInstanceId) return;
    managed.client.lastHeartbeatAt = Date.parse(heartbeat.timestamp);
    this.options.workers.upsert({
      workerInstanceId: heartbeat.workerInstanceId,
      boardId: heartbeat.boardId,
      pid: managed.client.pid ?? -1,
      processStartTime: managed.client.processStartTime,
      daemonInstanceId: this.options.daemonInstanceId,
      status: heartbeat.status,
      startedAt: managed.client.processStartTime,
      lastHeartbeatAt: heartbeat.timestamp,
      currentCommandId: heartbeat.currentCommandId,
      ownedDssProcesses: heartbeat.dssProcesses
    });
    this.options.registry.heartbeat(heartbeat.boardId, heartbeat.timestamp);
  }

  private async checkHeartbeats(): Promise<void> {
    const now = Date.now();
    for (const [boardId, managed] of this.workers) {
      const last = managed.client.lastHeartbeatAt ?? Date.parse(managed.client.processStartTime);
      if (now - last <= this.workerConfig.heartbeatTimeoutMs) continue;
      this.options.events.append({ level: "warn", sourceType: "worker", sourceId: managed.client.workerInstanceId, boardId, workerInstanceId: managed.client.workerInstanceId, eventType: "WORKER_HEARTBEAT_TIMEOUT", payload: { timeoutMs: this.workerConfig.heartbeatTimeoutMs } });
      await this.restartBoard(boardId, "heartbeat-timeout", { code: "WorkerHeartbeatTimeout" });
    }
  }

  private get workerConfig() {
    return {
      heartbeatIntervalMs: this.options.config.workers?.heartbeatIntervalMs ?? 1000,
      heartbeatTimeoutMs: this.options.config.workers?.heartbeatTimeoutMs ?? 5000,
      defaultCommandTimeoutMs: this.options.config.workers?.defaultCommandTimeoutMs ?? 15000,
      restartLimit: this.options.config.workers?.restartLimit ?? 5,
      restartWindowMs: this.options.config.workers?.restartWindowMs ?? 60000,
      shutdownTimeoutMs: 10000
    };
  }

  private get requiresCcxmlProbeValidation(): boolean {
    return this.options.config.adapter !== "mock" && this.options.config.ccs.scriptingMode !== "mock";
  }

  private assertResponseIdentity(boardId: string, worker: BoardWorkerClient, result: Record<string, unknown>): void {
    const board = this.options.registry.get(boardId);
    const mismatch = result.boardId !== boardId ||
      result.probeSerial !== board.probeSerial ||
      result.workerInstanceId !== worker.workerInstanceId;
    if (mismatch) {
      throw new DebugMcpError("WorkerIdentityMismatch", "Worker response identity does not match its board route", {
        expected: { boardId, probeSerial: board.probeSerial, workerInstanceId: worker.workerInstanceId },
        received: { boardId: result.boardId, probeSerial: result.probeSerial, workerInstanceId: result.workerInstanceId }
      });
    }
  }
}

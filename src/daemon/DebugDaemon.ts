import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { C2000McpConfig } from "../config/config.schema.js";
import { createC2000McpRuntime, type C2000McpRuntime } from "../server.js";
import { createDaemonHealth } from "./DaemonHealthService.js";
import { daemonRuntimePaths, newAuthTokenFile, removeDaemonInstance, writeDaemonInstance, type DaemonRuntimePaths, type DebugDaemonInstance } from "./DaemonInstanceFile.js";
import { resolveDaemonConfig } from "./DaemonConfig.js";
import { DaemonRpcServer } from "./DaemonRpcServer.js";
import { SqliteStore } from "../storage/SqliteStore.js";
import { BoardRepository } from "../storage/repositories/BoardRepository.js";
import { WorkerRepository } from "../storage/repositories/WorkerRepository.js";
import { TestRunRepository } from "../storage/repositories/TestRunRepository.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { LeaseRepository } from "../storage/repositories/LeaseRepository.js";
import { BoardRegistry } from "../boards/BoardRegistry.js";
import { BoardWorkerSupervisor } from "../boards/BoardWorkerSupervisor.js";
import { SessionRepository } from "../storage/repositories/SessionRepository.js";
import { DaemonToolRouter } from "./DaemonToolRouter.js";
import { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import { TestJobEngine } from "../jobs/TestJobEngine.js";
import { BoardGroupRepository } from "../storage/repositories/BoardGroupRepository.js";
import { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import { CanAcceptanceService } from "../can/CanAcceptanceService.js";
import { DatabaseConsistencyChecker } from "../storage/DatabaseConsistencyChecker.js";

/** Owns all durable debug state. A proxy may disconnect without affecting it. */
export class DebugDaemon {
  private readonly startedAtMs = Date.now();
  private readonly instanceId = randomUUID();
  private readonly authToken = randomBytes(32).toString("base64url");
  private readonly daemonConfig;
  private readonly paths: DaemonRuntimePaths;
  private runtime?: C2000McpRuntime;
  private store?: SqliteStore;
  private consistency?: DatabaseConsistencyChecker;
  private registry?: BoardRegistry;
  private workers?: WorkerRepository;
  private testRuns?: TestRunRepository;
  private sessions?: SessionRepository;
  private workerSupervisor?: BoardWorkerSupervisor;
  private jobEngine?: TestJobEngine;
  private rpcServer?: DaemonRpcServer;
  private instance?: DebugDaemonInstance;
  private stopping?: Promise<void>;

  constructor(private readonly config: C2000McpConfig) {
    this.daemonConfig = resolveDaemonConfig(config);
    this.paths = daemonRuntimePaths(this.daemonConfig.runtimeDir);
  }

  async start(): Promise<DebugDaemonInstance> {
    if (this.instance) return this.instance;
    const databasePath = path.resolve(this.config.storage?.sqlitePath ?? "./runtime/c2000-debugd.sqlite");
    const store = await SqliteStore.open(databasePath, { wal: this.config.storage?.wal ?? true });
    this.store = store;
    this.consistency = new DatabaseConsistencyChecker(store);
    const boards = new BoardRepository(store);
    const events = new EventRepository(store);
    const artifacts = new ArtifactRepository(store);
    const groups = new BoardGroupRepository(store);
    const canResults = new CanTestResultRepository(store);
    this.workers = new WorkerRepository(store);
    this.testRuns = new TestRunRepository(store);
    this.sessions = new SessionRepository(store);
    this.registry = new BoardRegistry(boards, events, store, new LeaseRepository(store));
    this.registry.registerAll((this.config.boards ?? []).map(board => ({
      boardId: board.boardId,
      probeSerial: board.probeSerial,
      device: board.device,
      ccxmlPath: board.ccxmlPath,
      tags: board.tags
    })));
    const runtime = await createC2000McpRuntime(this.config, {
      getDaemonHealth: () => this.getHealth(),
      listBoards: input => ({ boards: this.registry?.list(input) ?? [] }),
      recoverBoard: input => this.recoverBoard(input),
      submitTestPlan: input => this.requireJobEngine().submit(input.plan),
      getTestRun: input => this.requireJobEngine().get(input.jobId, input),
      listTestRuns: input => this.requireJobEngine().list(input.status),
      cancelTestRun: input => this.requireJobEngine().cancel(input.jobId),
      getTestArtifacts: input => ({ jobId: input.jobId, artifacts: artifacts.list(input.jobId) }),
      submitMultiBoardIpcAcceptance: input => this.requireJobEngine().submit({
        planVersion: 1,
        name: "multi-board-ipc-acceptance",
        boardIds: input.boardIds,
        artifacts: input.artifacts,
        parallelism: input.parallelism,
        steps: [
          { type: "launchMulticore" },
          { type: "runIpcAcceptance", timeoutMs: input.timeoutMs, verifyRuntimeRamOwnership: input.verifyRuntimeRamOwnership },
          { type: "cleanup" }
        ],
        failurePolicy: { ...input.failurePolicy, collectDebugBundle: input.collectDebugBundle },
        recoveryPolicy: "safe_restart_board"
      }),
      submitMultiBoardCanAcceptance: input => this.requireJobEngine().submit({
        planVersion: 1,
        name: input.name,
        boardIds: input.boardIds,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        can: { profile: input.profile },
        steps: [{ type: "launchMulticore" }, { type: "canAcceptance" }, { type: "cleanup" }],
        failurePolicy: input.failurePolicy,
        recoveryPolicy: "safe_restart_board"
      })
    });
    this.runtime = runtime;
    const workerSupervisor = new BoardWorkerSupervisor({
      config: this.config,
      daemonInstanceId: this.instanceId,
      registry: this.registry,
      workers: this.workers,
      events,
    });
    this.workerSupervisor = workerSupervisor;
    const toolRouter = new DaemonToolRouter(runtime.toolInvoker, this.registry, workerSupervisor, this.sessions);
    this.jobEngine = new TestJobEngine({
      registry: this.registry,
      runs: this.testRuns,
      events,
      artifacts,
      tools: toolRouter,
      maxParallelBoards: this.config.scheduler?.maxParallelBoards ?? 4,
      canAcceptance: new CanAcceptanceService({ groups, results: canResults, events, tools: toolRouter }),
      canResults,
      boardGroups: groups
    });
    const rpcServer = new DaemonRpcServer({
      authToken: this.authToken,
      port: this.daemonConfig.port,
      toolInvoker: toolRouter,
      health: () => this.getHealth()
    });
    this.rpcServer = rpcServer;
    try {
      const endpoint = await rpcServer.listen();
      const instance: DebugDaemonInstance = {
        instanceId: this.instanceId,
        pid: process.pid,
        startedAt: new Date(this.startedAtMs).toISOString(),
        host: endpoint.host,
        port: endpoint.port,
        authTokenFile: newAuthTokenFile(this.paths, this.instanceId),
        databasePath,
        version: "0.1.0"
      };
      await writeDaemonInstance(this.paths, instance, this.authToken);
      this.instance = instance;
      await workerSupervisor.startAll();
      const recovering = this.testRuns.markRecovering();
      for (const jobId of recovering) {
        events.append({ level: "warn", sourceType: "daemon", sourceId: instance.instanceId, jobId, eventType: "JOB_MARKED_RECOVERING", payload: {} });
      }
      this.jobEngine.start();
      return instance;
    } catch (error) {
      await rpcServer.close().catch(() => undefined);
      await workerSupervisor.stopAll().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      store.close();
      this.rpcServer = undefined;
      this.runtime = undefined;
      this.store = undefined;
      this.consistency = undefined;
      this.sessions = undefined;
      this.workerSupervisor = undefined;
      this.jobEngine = undefined;
      throw error;
    }
  }

  getHealth(): Record<string, unknown> {
    return createDaemonHealth(
      this.instance,
      this.startedAtMs,
      Boolean(this.store),
      this.workers?.countHealthy(),
      this.testRuns?.counts()
      , this.consistency?.check()
    );
  }

  async stop(): Promise<void> {
    this.stopping ??= this.stopInternal();
    return this.stopping;
  }

  private async stopInternal(): Promise<void> {
    this.jobEngine?.beginStop();
    if (this.testRuns) {
      const recovering = this.testRuns.markRecovering();
      for (const jobId of recovering) {
        // Event writing remains available until after the engine has stopped.
        this.store && new EventRepository(this.store).append({ level: "warn", sourceType: "daemon", sourceId: this.instanceId, jobId, eventType: "JOB_MARKED_RECOVERING_ON_STOP", payload: {} });
      }
    }
    await this.rpcServer?.close().catch(() => undefined);
    await this.jobEngine?.stop().catch(() => undefined);
    await this.workerSupervisor?.stopAll().catch(() => undefined);
    await this.runtime?.dispose().catch(() => undefined);
    this.store?.close();
    await removeDaemonInstance(this.paths, this.instance?.instanceId);
    this.rpcServer = undefined;
    this.runtime = undefined;
    this.store = undefined;
    this.consistency = undefined;
    this.registry = undefined;
    this.workers = undefined;
    this.testRuns = undefined;
    this.sessions = undefined;
    this.workerSupervisor = undefined;
    this.jobEngine = undefined;
    this.instance = undefined;
  }

  private requireJobEngine(): TestJobEngine {
    if (!this.jobEngine) throw new Error("Test job engine is not ready");
    return this.jobEngine;
  }

  private async recoverBoard(input: { boardId: string; dryRun: boolean }): Promise<Record<string, unknown>> {
    const board = this.registry?.get(input.boardId);
    const supervisor = this.workerSupervisor;
    if (!board || !supervisor) throw new Error("Board recovery is not ready");
    if (input.dryRun) {
      return {
        success: true,
        dryRun: true,
        boardId: board.boardId,
        probeSerial: board.probeSerial,
        action: "RESTART_DAEMON_OWNED_WORKER_ONLY",
        externalProcessTermination: false
      };
    }
    await supervisor.restartBoard(board.boardId, "operator-requested-recovery", { requestedBy: "c2000_recoverBoard" });
    return {
      success: true,
      dryRun: false,
      boardId: board.boardId,
      probeSerial: board.probeSerial,
      action: "RESTARTED_DAEMON_OWNED_WORKER_ONLY",
      externalProcessTermination: false
    };
  }
}

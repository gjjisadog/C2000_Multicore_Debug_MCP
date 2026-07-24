import type { C2000ToolInvoker } from "../mcp/tools.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { BoardGroupRepository } from "../storage/repositories/BoardGroupRepository.js";
import { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import type { TestPlan, TestPlanStep } from "../jobs/TestPlanSchema.js";
import { BoardGroupBarrier } from "./BoardGroupBarrier.js";
import type { CanBusAdapter, CanFrame } from "./CanBusAdapter.js";
import { MockCanBusAdapter } from "./MockCanBusAdapter.js";
import type { CanAcceptanceProfile } from "./CanProfileSchema.js";
import { NoopCanBusAdapter } from "./NoopCanBusAdapter.js";

export interface CanStepContext {
  jobId: string;
  boardId: string;
  sessionId?: string;
  plan: TestPlan;
  step: TestPlanStep;
}

interface PendingCanRun {
  participants: string[];
  contexts: Map<string, CanStepContext>;
  barrier: BoardGroupBarrier;
  execution?: Promise<Record<string, unknown>>;
}

export type CanBusAdapterFactory = (kind: "mock" | "hardware") => CanBusAdapter;

/** Coordinates two independently owned board workers without sharing debug sessions between them. */
export class CanAcceptanceService {
  private readonly pending = new Map<string, PendingCanRun>();
  private readonly adapterFactory: CanBusAdapterFactory;

  constructor(private readonly options: {
    groups: BoardGroupRepository;
    results: CanTestResultRepository;
    events: EventRepository;
    tools: C2000ToolInvoker;
    adapterFactory?: CanBusAdapterFactory;
  }) {
    this.adapterFactory = options.adapterFactory ?? (kind => kind === "mock" ? new MockCanBusAdapter() : new NoopCanBusAdapter());
  }

  /** Called at submit time, before workers are scheduled, to make the physical topology durable. */
  prepare(jobId: string, plan: TestPlan, boardIds: readonly string[]): string {
    const can = plan.can;
    if (!can?.groupId) throw new DebugMcpError("CanProfileInvalid", "CAN job is missing its durable groupId");
    if (boardIds.length !== 2 || boardIds[0] === boardIds[1]) throw new DebugMcpError("CanProfileInvalid", "CAN acceptance requires exactly two distinct boards", { boardIds });
    this.validateProfileBoards(can.profile.directions, boardIds);
    this.options.groups.createCanPair({
      groupId: can.groupId,
      name: `${plan.name} CAN pair`,
      boardIds: [boardIds[0]!, boardIds[1]!],
      metadata: { jobId, adapter: can.profile.adapter, directions: can.profile.directions, faults: can.profile.faults }
    });
    this.options.events.append({ level: "info", sourceType: "can", sourceId: can.groupId, jobId, eventType: "CAN_GROUP_CREATED", payload: { boardIds, adapter: can.profile.adapter } });
    return can.groupId;
  }

  async execute(context: CanStepContext): Promise<Record<string, unknown>> {
    const can = context.plan.can;
    if (!can?.groupId) throw new DebugMcpError("CanProfileInvalid", "canAcceptance step requires plan.can.groupId");
    if (!context.sessionId) throw new DebugMcpError("CanProfileInvalid", "CAN acceptance requires a launched debug session", { boardId: context.boardId });
    const entry = this.getOrRestore(context.jobId, context.plan);
    entry.contexts.set(context.boardId, context);
    try {
      await entry.barrier.arrive(context.boardId);
      entry.execution ??= this.runGroup(context.jobId, context.plan, entry);
      return await entry.execution;
    } catch (error) {
      entry.barrier.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private getOrRestore(jobId: string, plan: TestPlan): PendingCanRun {
    const existing = this.pending.get(jobId);
    if (existing) return existing;
    const groupId = plan.can?.groupId;
    if (!groupId) throw new DebugMcpError("CanProfileInvalid", "CAN job has no groupId");
    const group = this.options.groups.require(groupId);
    if (group.groupType !== "CAN_PAIR" || group.members.length !== 2) {
      throw new DebugMcpError("CanProfileInvalid", "Durable CAN group is not a two-board pair", { groupId, groupType: group.groupType, members: group.members });
    }
    const entry: PendingCanRun = {
      participants: group.members.map(member => member.boardId),
      contexts: new Map(),
      barrier: new BoardGroupBarrier(group.members.map(member => member.boardId), plan.can!.profile.barrierTimeoutMs)
    };
    this.pending.set(jobId, entry);
    return entry;
  }

  private async runGroup(jobId: string, plan: TestPlan, entry: PendingCanRun): Promise<Record<string, unknown>> {
    const can = plan.can!;
    const adapter = this.adapterFactory(can.profile.adapter);
    const groupId = can.groupId!;
    this.options.groups.setStatus(groupId, "RUNNING");
    this.record(jobId, groupId, "BARRIER", "PASSED", { participants: entry.participants, sessions: [...entry.contexts.entries()].map(([boardId, value]) => ({ boardId, sessionId: value.sessionId })) });
    try {
      await adapter.open({ jobId, boardIds: entry.participants, faults: can.profile.faults });
      if (can.profile.autoRunCores) await this.runCores(entry, can.profile.runCoreIds);
      const directionResults: Record<string, unknown>[] = [];
      for (const direction of can.profile.directions) {
        const frames: Record<string, unknown>[] = [];
        for (const requested of direction.frames) {
          const frame: CanFrame = { id: requested.id, data: [...requested.data], extended: requested.extended };
          const capture = await adapter.send({ sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId, frame });
          const received = await adapter.receive({ sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId, timeoutMs: can.profile.timeoutMs });
          const delivered = received !== undefined;
          if (direction.expectDelivery !== delivered) {
            throw new DebugMcpError("CanFrameMismatch", "CAN frame delivery did not match the direction expectation", {
              direction, expectedDelivery: direction.expectDelivery, delivered, capture, received
            });
          }
          if (received && !framesEqual(frame, received)) {
            throw new DebugMcpError("CanFrameMismatch", "CAN receive payload differs from sent frame", { direction, sent: frame, received, capture });
          }
          frames.push({ frame, capture, ...(received ? { received } : {}) });
        }
        const result = { direction: { sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId }, expectDelivery: direction.expectDelivery, frames };
        directionResults.push(result);
        this.record(jobId, groupId, "DIRECTION", "PASSED", result);
      }
      const observations = await this.collectObservations(entry, can.profile.observations);
      this.record(jobId, groupId, "OBSERVABILITY", "PASSED", { observations, requested: can.profile.observations.length > 0 });
      const summary = {
        success: true,
        groupId,
        adapter: adapter.kind,
        simulation: adapter.kind === "mock",
        directions: directionResults,
        observations,
        captures: adapter.captures()
      };
      this.options.groups.setStatus(groupId, "READY");
      this.options.events.append({ level: "info", sourceType: "can", sourceId: groupId, jobId, eventType: "CAN_ACCEPTANCE_PASSED", payload: summary });
      return summary;
    } catch (error) {
      const structured = toStructuredError(error);
      this.options.groups.setStatus(groupId, "FAILED");
      this.record(jobId, groupId, "FAILURE", "FAILED", { error: structured, captures: adapter.captures() });
      this.options.events.append({ level: "error", sourceType: "can", sourceId: groupId, jobId, eventType: "CAN_ACCEPTANCE_FAILED", payload: { error: structured } });
      throw error;
    } finally {
      await adapter.close().catch(() => undefined);
      this.pending.delete(jobId);
    }
  }

  private async runCores(entry: PendingCanRun, coreIds: number[]): Promise<void> {
    await Promise.all([...entry.contexts.values()].map(async context => {
      const result = await this.options.tools.invokeTool("c2000_runCores", { sessionId: context.sessionId, coreIds });
      assertSuccess(result, "Could not start CAN participant cores", { boardId: context.boardId, sessionId: context.sessionId });
    }));
  }

  private async collectObservations(entry: PendingCanRun, observations: CanAcceptanceProfile["observations"]): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    for (const observation of observations) {
      const context = entry.contexts.get(observation.boardId);
      if (!context?.sessionId) throw new DebugMcpError("CanProfileInvalid", "CAN observation has no launched board session", { boardId: observation.boardId });
      const result = await this.options.tools.invokeTool("c2000_evaluateMany", {
        sessionId: context.sessionId,
        coreId: observation.coreId,
        expressions: observation.expressions.map(expression => expression.expression)
      });
      assertSuccess(result, "CAN debug observation failed", { boardId: observation.boardId, coreId: observation.coreId });
      assertExpectedObservation(result, observation.expressions, observation.boardId, observation.coreId);
      collected.push({ boardId: observation.boardId, coreId: observation.coreId, result });
    }
    return collected;
  }

  private validateProfileBoards(directions: Array<{ sourceBoardId: string; targetBoardId: string }>, boardIds: readonly string[]): void {
    const allowed = new Set(boardIds);
    const routeSet = new Set(directions.map(direction => `${direction.sourceBoardId}->${direction.targetBoardId}`));
    for (const direction of directions) {
      if (direction.sourceBoardId === direction.targetBoardId || !allowed.has(direction.sourceBoardId) || !allowed.has(direction.targetBoardId)) {
        throw new DebugMcpError("CanProfileInvalid", "CAN direction must join two selected, distinct boards", { direction, boardIds });
      }
    }
    const [first, second] = boardIds;
    if (!routeSet.has(`${first}->${second}`) || !routeSet.has(`${second}->${first}`)) {
      throw new DebugMcpError("CanProfileInvalid", "CAN profile must cover both board-to-board directions", { boardIds, directions });
    }
  }

  private record(jobId: string, groupId: string, phase: string, status: "PASSED" | "FAILED" | "SKIPPED" | "INFO", details: Record<string, unknown>): void {
    this.options.results.add({ jobId, groupId, phase, status, details });
  }
}

function assertSuccess(result: Record<string, unknown>, message: string, details: Record<string, unknown>): void {
  if (result.success !== true) throw new DebugMcpError("CanDebugObservationFailed", message, { ...details, result });
}

function assertExpectedObservation(result: Record<string, unknown>, expected: Array<{ expression: string; expected?: string | number | boolean }>, boardId: string, coreId: number): void {
  const results = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : [];
  for (const item of expected) {
    if (item.expected === undefined) continue;
    const actual = results.find(value => value.expression === item.expression)?.value;
    if (actual !== item.expected) {
      throw new DebugMcpError("CanDebugObservationFailed", "CAN debug expression did not match its expected value", { boardId, coreId, expression: item.expression, expected: item.expected, actual });
    }
  }
}

function framesEqual(left: CanFrame, right: CanFrame): boolean {
  return left.id === right.id && left.extended === right.extended && left.data.length === right.data.length && left.data.every((value, index) => value === right.data[index]);
}

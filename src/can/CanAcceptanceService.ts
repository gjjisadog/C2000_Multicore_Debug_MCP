import type { C2000ToolInvoker } from "../mcp/tools.js";
import { EventRepository } from "../storage/repositories/EventRepository.js";
import { BoardGroupRepository, type BoardGroupMemberStatus } from "../storage/repositories/BoardGroupRepository.js";
import { BoardGroupBarrierRepository, type BoardGroupBarrierName } from "../storage/repositories/BoardGroupBarrierRepository.js";
import { CanTestResultRepository } from "../storage/repositories/CanTestResultRepository.js";
import { DebugMcpError, toStructuredError } from "../utils/errors.js";
import { resolveArtifactsForBoard, type TestPlan, type TestPlanStep } from "../jobs/TestPlanSchema.js";
import { PersistentBoardGroupBarrier } from "./PersistentBoardGroupBarrier.js";
import { CanProfileRegistry } from "./CanProfileRegistry.js";
import { CrossBoardExpressionService } from "./CrossBoardExpressionService.js";
import { CanCampaignRepository, type CanCampaignType } from "../storage/repositories/CanCampaignRepository.js";
import { CanReportService } from "./CanReportService.js";
import type { CanBusAdapter, CanFrame } from "./CanBusAdapter.js";
import { MockCanBusAdapter } from "./MockCanBusAdapter.js";
import type { CanAcceptanceProfile } from "./CanProfileSchema.js";
import { NoopCanBusAdapter } from "./NoopCanBusAdapter.js";
import type { BoardLeaseContext } from "../boards/types.js";
import { evaluateCanDirectionEvidence, type FirmwareCanEvidence } from "./CanEvidenceModel.js";

export interface CanStepContext {
  jobId: string;
  boardId: string;
  sessionId?: string;
  leaseId?: string;
  leaseContext?: BoardLeaseContext;
  workerInstanceId?: string;
  probeSerial?: string;
  heartbeatSnapshot?: Record<string, unknown>;
  signal?: AbortSignal;
  plan: TestPlan;
  step: TestPlanStep;
}

interface PendingCanRun {
  participants: string[];
  contexts: Map<string, CanStepContext>;
  execution?: Promise<Record<string, unknown>>;
}

export type CanBusAdapterFactory = (kind: "mock" | "hardware") => CanBusAdapter;

/**
 * Coordinates two independently owned board workers without sharing debug
 * sessions between them. Every rendezvous is persisted before any waiter is
 * released, so a daemon crash leaves recoverable evidence instead of an
 * invisible in-memory barrier.
 */
export class CanAcceptanceService {
  private readonly pending = new Map<string, PendingCanRun>();
  private readonly adapterFactory: CanBusAdapterFactory;
  private readonly barrier: PersistentBoardGroupBarrier;
  private readonly expressions: CrossBoardExpressionService;

  constructor(private readonly options: {
    groups: BoardGroupRepository;
    barriers: BoardGroupBarrierRepository;
    profiles: CanProfileRegistry;
    campaigns: CanCampaignRepository;
    reports?: CanReportService;
    results: CanTestResultRepository;
    events: EventRepository;
    tools: C2000ToolInvoker;
    adapterFactory?: CanBusAdapterFactory;
  }) {
    this.adapterFactory = options.adapterFactory ?? (kind => kind === "mock" ? new MockCanBusAdapter() : new NoopCanBusAdapter());
    this.barrier = new PersistentBoardGroupBarrier(options.barriers);
    this.expressions = new CrossBoardExpressionService(options.tools);
  }

  /** Called at submit time, before workers are scheduled, to make topology and exclusivity durable. */
  prepare(jobId: string, plan: TestPlan, boardIds: readonly string[]): string {
    const can = plan.can;
    if (!can?.groupId) throw new DebugMcpError("CanProfileInvalid", "CAN job is missing its durable groupId");
    if (boardIds.length !== 2 || boardIds[0] === boardIds[1]) throw new DebugMcpError("CanProfileInvalid", "CAN acceptance requires exactly two distinct boards", { boardIds });
    const registeredProfile = this.options.profiles.register(can.profile);
    this.validateProfileBoards(registeredProfile.parsed.directions, boardIds);
    const members = boardIds.map((boardId, index) => {
      const declared = registeredProfile.parsed.roles.find(role => role.boardId === boardId) ?? registeredProfile.parsed.roles[index];
      return { boardId, role: declared?.role ?? (index === 0 ? "PRIMARY" : "SECONDARY"), ...(declared?.nodeId !== undefined ? { nodeId: declared.nodeId } : {}), ...(declared?.channel ? { channel: declared.channel } : {}) };
    });
    this.options.groups.createCanGroup({
      groupId: can.groupId,
      jobId,
      name: `${plan.name} CAN pair`,
      boardIds: [boardIds[0]!, boardIds[1]!],
      members,
      busId: registeredProfile.parsed.bus.name,
      profile: { id: registeredProfile.profileId, version: registeredProfile.version, hash: registeredProfile.hash },
      topology: { kind: "two-board-can", boardIds, roles: members, directions: registeredProfile.parsed.directions.map(direction => ({ sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId })) },
      failurePolicy: plan.failurePolicy as Record<string, unknown>,
      metadata: { adapter: registeredProfile.parsed.adapter, directions: registeredProfile.parsed.directions, faults: registeredProfile.parsed.faults, profileId: registeredProfile.profileId, profileVersion: registeredProfile.version, profileHash: registeredProfile.hash }
    });
    this.options.events.append({ level: "info", sourceType: "can", sourceId: can.groupId, jobId, eventType: "CAN_GROUP_CREATED", payload: { boardIds, adapter: registeredProfile.parsed.adapter, profileId: registeredProfile.profileId, profileVersion: registeredProfile.version, profileHash: registeredProfile.hash, state: "ALLOCATING" } });
    return can.groupId;
  }

  /** Called after the immutable test-run record exists, satisfying campaign FKs without weakening group preflight. */
  initializeCampaign(jobId: string, plan: TestPlan): void {
    const can = plan.can;
    if (!can?.groupId || !can.execution.campaignId) return;
    if (this.options.campaigns.getByJob(jobId)) return;
    const mode = can.execution.mode;
    const cases = mode === "matrix"
      ? can.execution.matrixCases.map((item, index) => ({ ...item, caseIndex: index }))
      : Array.from({ length: can.execution.iterations }, (_item, index) => ({ name: `${mode}-${index + 1}`, iteration: index + 1, faults: can.profile.faults }));
    this.options.campaigns.create({
      campaignId: can.execution.campaignId,
      jobId,
      groupId: can.groupId,
      type: campaignType(mode),
      definition: { mode, iterations: can.execution.iterations, durationMs: can.execution.durationMs, failFast: can.execution.failFast, health: can.execution.health, resetOrRejoinRequested: can.execution.resetOrRejoinRequested },
      cases
    });
  }

  async execute(context: CanStepContext): Promise<Record<string, unknown>> {
    const can = context.plan.can;
    if (!can?.groupId) throw new DebugMcpError("CanProfileInvalid", "canAcceptance step requires plan.can.groupId");
    if (!context.sessionId) throw new DebugMcpError("CanProfileInvalid", "CAN acceptance requires a launched debug session", { boardId: context.boardId });
    if (!context.leaseId) throw new DebugMcpError("BoardLeaseRequired", "CAN acceptance requires an active board lease", { boardId: context.boardId, jobId: context.jobId });
    const entry = this.getOrRestore(context.jobId, context.plan);
    entry.contexts.set(context.boardId, context);
    this.options.groups.updateMember(can.groupId, context.boardId, {
      sessionId: context.sessionId,
      leaseId: context.leaseId,
      ...(context.workerInstanceId ? { workerInstanceId: context.workerInstanceId } : {}),
      ...(context.probeSerial ? { probeSerial: context.probeSerial } : {}),
      heartbeatSnapshot: context.heartbeatSnapshot ?? {},
      lastHeartbeatAt: new Date().toISOString(),
      status: "RESERVED"
    });
    try {
      const reserved = await this.waitBarrier(context, entry, "ALL_RESERVED", { leaseId: context.leaseId });
      this.record(context.jobId, can.groupId, "BARRIER", "PASSED", { name: reserved.name, status: reserved.status, arrivals: Object.keys(reserved.arrivedMembers) });
      this.options.groups.updateMember(can.groupId, context.boardId, { status: "STARTING" });
      const workersReady = await this.waitBarrier(context, entry, "ALL_WORKERS_READY", { sessionId: context.sessionId, workerInstanceId: context.workerInstanceId ?? null });
      this.record(context.jobId, can.groupId, "BARRIER", "PASSED", { name: workersReady.name, status: workersReady.status, arrivals: Object.keys(workersReady.arrivedMembers) });
      entry.execution ??= this.runGroup(context.jobId, context.plan, entry);
      return await entry.execution;
    } catch (error) {
      const structured = toStructuredError(error);
      this.options.groups.updateMember(can.groupId, context.boardId, { status: "FAILED", error: errorRecord(structured) });
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
    if (group.status === "ALLOCATING") this.options.groups.transition(groupId, "STARTING", { reason: "CAN members entered worker-routed setup" });
    const entry: PendingCanRun = { participants: group.members.map(member => member.boardId), contexts: new Map() };
    this.pending.set(jobId, entry);
    return entry;
  }

  private async runGroup(jobId: string, plan: TestPlan, entry: PendingCanRun): Promise<Record<string, unknown>> {
    const can = plan.can!;
    const groupId = can.groupId!;
    const groupAtStart = this.options.groups.require(groupId);
    const profile = this.resolveProfile(groupAtStart, can.profile);
    const adapter = this.adapterFactory(profile.adapter);
    try {
      const launchEvidence = profile.adapter === "hardware" ? await this.inspectLaunchEvidence(entry, plan, profile.runCoreIds) : undefined;
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_CONNECTED", context => launchEvidence?.[context.boardId]?.connected ?? ({ sessionId: context.sessionId, status: "SIMULATION", connected: true }));
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_HALTED", context => launchEvidence?.[context.boardId]?.halted ?? ({ sessionId: context.sessionId, status: "SIMULATION", halted: true }));
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_LOADED", context => launchEvidence?.[context.boardId]?.loaded ?? ({ sessionId: context.sessionId, status: "SIMULATION", loaded: true }));
      this.setMembers(groupId, entry, "LOADED");
      this.options.groups.transition(groupId, "LOADED", { reason: "All member sessions connected, halted, and loaded" });

      const safety = await this.expressions.evaluateSafety(this.options.groups.require(groupId), profile);
      this.record(jobId, groupId, "SAFETY", safety.status === "PASSED" ? "PASSED" : safety.status === "UNSUPPORTED" ? "SKIPPED" : "FAILED", safety);
      if (profile.safety.required && safety.status !== "PASSED") {
        throw new DebugMcpError("CanSafetyGateFailed", "Read-only CAN safety gates did not pass", { safety, groupId, profileId: profile.profileId, version: profile.version });
      }
      if (safety.status === "PASSED") this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_SAFETY_READY", context => ({ sessionId: context.sessionId, safety: "read-only-gates-passed" }));
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_CONFIGURED", context => ({ sessionId: context.sessionId, adapter: profile.adapter, profileId: profile.profileId, version: profile.version }));
      this.setMembers(groupId, entry, "ARMED");
      this.options.groups.transition(groupId, "ARMED", { reason: safety.status === "PASSED" ? "CAN profile configured after read-only safety gates" : "Legacy profile has no declared safety gate; evidence marked UNSUPPORTED" });
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_ARMED", context => ({ profilePrepared: true, safetyStatus: safety.status }));

      const adapterSession = await adapter.openSession({ jobId, boardIds: entry.participants, faults: profile.faults });
      const captureSession = await adapter.startCapture();
      const adapterInfo = adapter.info();
      if (profile.requireIndependentBusVerification && !adapterInfo.independentBusVerification) {
        throw new DebugMcpError("CanIndependentBusVerificationRequired", "CAN profile requires independent physical-bus verification, but the selected adapter cannot provide it", { profileId: profile.profileId, adapter: adapterInfo });
      }
      if (profile.autoRunCores) await this.runCores(entry, profile.runCoreIds);
      this.setMembers(groupId, entry, "RUNNING");
      this.options.groups.transition(groupId, "RUNNING", { reason: "Participant cores run through worker-routed c2000_runCores" });
      const runningEvidence = profile.adapter === "hardware" ? await this.inspectRunningEvidence(entry, profile.runCoreIds) : undefined;
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_RUNNING", context => runningEvidence?.[context.boardId] ?? ({ sessionId: context.sessionId, status: "SIMULATION", running: true, runCoreIds: profile.runCoreIds }));

      const canReadyEvidence = adapter.kind === "mock"
        ? Object.fromEntries(entry.participants.map(boardId => [boardId, { status: "SIMULATION", canReady: true }]))
        : await this.assertFirmwareCanReady(entry, profile);
      this.setMembers(groupId, entry, "CAN_READY");
      this.options.groups.transition(groupId, "CAN_READY", { reason: "Firmware CAN readiness assertions passed", currentBarrier: "ALL_CAN_READY" });
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_CAN_READY", context => ({
        assertion: "firmware CAN initialized and controller not bus-off",
        expected: { canReady: true, busOffCount: 0 },
        actual: canReadyEvidence[context.boardId],
        evidence: [canReadyEvidence[context.boardId]],
        sampleWindow: { startedAt: captureSession.startedAt, finishedAt: new Date().toISOString(), maxSkewMs: 0 },
        adapter: adapterInfo.name,
        adapterSessionId: adapterSession.sessionId,
        simulation: adapter.kind === "mock"
      }));
      this.setMembers(groupId, entry, "TESTING");
      this.options.groups.transition(groupId, "TESTING", { reason: "Bidirectional CAN traffic verification started" });

      const campaignCases = await this.executeCampaignCases(jobId, groupId, plan, profile, adapter);
      const directionResults = campaignCases.flatMap(item => Array.isArray(item.directions) ? item.directions as Record<string, unknown>[] : []);
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_TEST_COMPLETE", () => ({ directions: directionResults.length }));
      const observations = await this.collectObservations(entry, profile.observations);
      this.record(jobId, groupId, "OBSERVABILITY", "PASSED", { observations, requested: profile.observations.length > 0 });
      const comparisons = await this.expressions.compare(this.options.groups.require(groupId), profile);
      if (comparisons.some(comparison => comparison.matched !== true)) {
        throw new DebugMcpError("CanCrossBoardComparisonFailed", "A cross-board CAN comparison did not match", { comparisons });
      }
      this.record(jobId, groupId, "CROSS_BOARD", "PASSED", { comparisons, requested: profile.comparisons.length > 0 });
      const captures = adapter.captures();
      const stoppedCapture = await adapter.stopCapture();
      const adapterStatistics = await adapter.getStatistics();
      this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_EVIDENCE_COLLECTED", () => ({ captureCount: captures.length, adapter: adapterInfo }));
      this.setMembers(groupId, entry, "PASSED");
      this.options.groups.transition(groupId, "PASSED", { reason: "CAN acceptance evidence collected" });
      const completedGroup = this.options.groups.require(groupId);
      const campaign = this.options.campaigns.getByJob(jobId);
      const reportArtifacts = this.options.reports ? await this.options.reports.write({
        jobId,
        group: completedGroup,
        barriers: this.options.barriers.list(groupId),
        results: this.options.results.list(jobId),
        ...(campaign ? { campaign, cases: this.options.campaigns.cases(campaign.campaignId) } : {}),
        adapter: adapterInfo,
        captures,
        simulation: adapter.kind === "mock"
      }) : [];
      const summary = {
        success: true,
        groupId,
        adapter: adapter.kind,
        adapterInfo,
        adapterSession,
        adapterState: adapter.state(),
        simulation: adapter.kind === "mock",
        independentBusVerification: adapterInfo.independentBusVerification,
        directions: directionResults,
        campaignCases,
        observations,
        comparisons,
        captures,
        captureSession,
        stoppedCapture,
        adapterStatistics,
        barriers: this.options.barriers.list(groupId)
        , reportArtifacts
      };
      this.options.events.append({ level: "info", sourceType: "can", sourceId: groupId, jobId, eventType: "CAN_ACCEPTANCE_PASSED", payload: summary });
      return summary;
    } catch (error) {
      const structured = toStructuredError(error);
      const campaign = this.options.campaigns.getByJob(jobId);
      if (campaign && !["PASSED", "PARTIAL", "FAILED"].includes(campaign.status)) {
        this.options.campaigns.update(campaign.campaignId, "FAILED", { error: errorRecord(structured) });
      }
      const group = this.options.groups.require(groupId);
      if (!this.options.groups.isTerminal(group.status)) this.options.groups.transition(groupId, "FAILED", { reason: "CAN acceptance error", error: errorRecord(structured) });
      this.setMembers(groupId, entry, "FAILED", errorRecord(structured));
      this.record(jobId, groupId, "FAILURE", "FAILED", { error: structured, captures: adapter.captures(), adapterInfo: adapter.info() });
      this.options.events.append({ level: "error", sourceType: "can", sourceId: groupId, jobId, eventType: "CAN_ACCEPTANCE_FAILED", payload: { error: structured } });
      throw error;
    } finally {
      await adapter.stopCapture().catch(() => undefined);
      await adapter.close().catch(() => undefined);
      const group = this.options.groups.require(groupId);
      if (group.status === "PASSED") {
        this.observeBarrier(jobId, groupId, entry, profile.barrierTimeoutMs, "ALL_CLEANED_UP", () => ({ adapterClosed: true }));
      }
      this.pending.delete(jobId);
    }
  }

  private async waitBarrier(context: CanStepContext, entry: PendingCanRun, name: Extract<BoardGroupBarrierName, "ALL_RESERVED" | "ALL_WORKERS_READY">, details: Record<string, unknown>) {
    const groupId = context.plan.can!.groupId!;
    this.options.groups.setCurrentBarrier(groupId, name);
    return this.barrier.arriveAndWait({ groupId, jobId: context.jobId, name, expectedMembers: entry.participants, boardId: context.boardId, timeoutMs: context.plan.can!.profile.barrierTimeoutMs, details });
  }

  private observeBarrier(jobId: string, groupId: string, entry: PendingCanRun, timeoutMs: number, name: Exclude<BoardGroupBarrierName, "ALL_RESERVED" | "ALL_WORKERS_READY">, observation: (context: CanStepContext) => Record<string, unknown>): void {
    this.options.groups.setCurrentBarrier(groupId, name);
    const startedAt = new Date().toISOString();
    const observations = Object.fromEntries(entry.participants.map(boardId => {
      const actual = observation(requireContext(entry, boardId));
      return [boardId, "assertion" in actual ? actual : {
        assertion: name,
        expected: { satisfied: true },
        actual,
        evidence: [actual],
        sampleWindow: { startedAt, finishedAt: new Date().toISOString(), maxSkewMs: 0 }
      }];
    }));
    const barrier = this.barrier.satisfyObserved({ groupId, jobId, name, expectedMembers: entry.participants, timeoutMs, observations });
    this.record(jobId, groupId, "BARRIER", "PASSED", { name: barrier.name, status: barrier.status, arrivals: Object.keys(barrier.arrivedMembers) });
  }

  private setMembers(groupId: string, entry: PendingCanRun, status: BoardGroupMemberStatus, error?: Record<string, unknown>): void {
    for (const boardId of entry.participants) this.options.groups.updateMember(groupId, boardId, { status, ...(error ? { error } : {}) });
  }

  private async runCores(entry: PendingCanRun, coreIds: number[]): Promise<void> {
    await Promise.all([...entry.contexts.values()].map(async context => {
      const result = await this.options.tools.invokeTool("c2000_runCores", { sessionId: context.sessionId, coreIds, ...(context.leaseContext ? { __leaseContext: context.leaseContext } : {}) });
      assertSuccess(result, "Could not start CAN participant cores", { boardId: context.boardId, sessionId: context.sessionId });
    }));
  }

  private async collectObservations(entry: PendingCanRun, observations: CanAcceptanceProfile["observations"]): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    for (const observation of observations) {
      const context = entry.contexts.get(observation.boardId);
      if (!context?.sessionId) throw new DebugMcpError("CanProfileInvalid", "CAN observation has no launched board session", { boardId: observation.boardId });
      const result = await this.options.tools.invokeTool("c2000_evaluateMany", { sessionId: context.sessionId, coreId: observation.coreId, expressions: observation.expressions.map(expression => expression.expression), ...(context.leaseContext ? { __leaseContext: context.leaseContext } : {}) });
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

  private resolveProfile(group: ReturnType<BoardGroupRepository["require"]>, fallback: CanAcceptanceProfile): CanAcceptanceProfile {
    if (!group.profileId || !group.profileVersion) return fallback;
    return this.options.profiles.require(group.profileId, group.profileVersion).parsed;
  }

  private async executeCampaignCases(jobId: string, groupId: string, plan: TestPlan, profile: CanAcceptanceProfile, adapter: CanBusAdapter): Promise<Record<string, unknown>[]> {
    const execution = plan.can!.execution;
    const campaign = this.options.campaigns.getByJob(jobId);
    const cases = campaign ? this.options.campaigns.cases(campaign.campaignId) : [{ caseId: "inline", caseIndex: 0, input: { name: "acceptance" } }];
    const startedAt = Date.now();
    const directions: Record<string, unknown>[] = [];
    let failures = 0;
    let consecutiveFailures = 0;
    let completedCases = 0;
    if (campaign) this.options.campaigns.update(campaign.campaignId, "RUNNING", { checkpoint: { nextCaseIndex: 0 } });
    for (const item of cases) {
      const signal = [...this.pending.values()].flatMap(entry => [...entry.contexts.values()]).find(context => context.jobId === jobId)?.signal;
      signal?.throwIfAborted();
      if (execution.mode === "soak" && execution.durationMs && Date.now() - startedAt >= execution.durationMs) break;
      if (campaign) this.options.campaigns.updateCase(item.caseId, "RUNNING");
      completedCases += 1;
      try {
        const result = await this.verifyTraffic(jobId, groupId, profile, adapter);
        directions.push({ caseId: item.caseId, caseIndex: item.caseIndex, input: item.input, directions: result });
        // Only a successful case breaks a consecutive-failure streak.
        consecutiveFailures = 0;
        if (campaign) {
          this.options.campaigns.updateCase(item.caseId, "PASSED", { result: { directions: result } });
          this.options.campaigns.checkpointSoak(campaign.campaignId, item.caseIndex + 1, Date.now() - startedAt, "PASSED", { failures, consecutiveFailures });
          this.options.campaigns.update(campaign.campaignId, "RUNNING", { checkpoint: { nextCaseIndex: item.caseIndex + 1, failures, consecutiveFailures } });
        }
      } catch (error) {
        failures += 1;
        consecutiveFailures += 1;
        const errorRecord = toErrorRecord(error);
        if (campaign) {
          this.options.campaigns.updateCase(item.caseId, "FAILED", { error: errorRecord });
          this.options.campaigns.checkpointSoak(campaign.campaignId, item.caseIndex + 1, Date.now() - startedAt, "FAILED", { failures, consecutiveFailures });
          this.options.campaigns.update(campaign.campaignId, "RUNNING", { checkpoint: { nextCaseIndex: item.caseIndex + 1, failures, consecutiveFailures } });
        }
        const failureRate = failures / completedCases;
        if (execution.failFast || exceedsHealthBudget(execution.health, consecutiveFailures, failureRate)) throw error;
      }
    }
    if (campaign) this.options.campaigns.update(campaign.campaignId, failures === 0 ? "PASSED" : "PARTIAL", { summary: { totalCases: completedCases, failures, elapsedMs: Date.now() - startedAt } });
    return directions;
  }

  private async verifyTraffic(jobId: string, groupId: string, profile: CanAcceptanceProfile, adapter: CanBusAdapter): Promise<Record<string, unknown>[]> {
    const directionResults: Record<string, unknown>[] = [];
    for (const direction of profile.directions) {
      const frames: Record<string, unknown>[] = [];
      for (const requested of direction.frames) {
        const frame: CanFrame = { id: requested.id, data: [...requested.data], extended: requested.extended };
        if (adapter.kind === "mock") {
          const requestedCapture = await adapter.send({ sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId, frame });
          const received = await adapter.receive({ sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId, timeoutMs: profile.timeoutMs });
          const busCapture = received ? adapter.captures().find(item => item === requestedCapture || (
            item.direction.sourceBoardId === direction.sourceBoardId && item.direction.targetBoardId === direction.targetBoardId && framesEqual(item.frame, frame)
          )) : undefined;
          const evidence = evaluateCanDirectionEvidence({
            trafficMode: profile.trafficMode,
            simulation: true,
            expectedFrame: frame,
            busCapture,
            applicationAssertionsRequested: profile.applicationAssertions.length > 0,
            applicationMatched: profile.applicationAssertions.length === 0 ? undefined : received !== undefined
          });
          const delivered = received !== undefined;
          if (direction.expectDelivery !== delivered) throw new DebugMcpError("CanFrameMismatch", "CAN frame delivery did not match the direction expectation", { direction, expectedDelivery: direction.expectDelivery, delivered, requestedCapture, received, evidence });
          if (received && !framesEqual(frame, received)) throw new DebugMcpError("CanFrameMismatch", "CAN receive payload differs from sent frame", { direction, sent: frame, received, requestedCapture });
          frames.push({ frame, requested: requestedCapture, ...(busCapture ? { busCapture } : {}), ...(received ? { received } : {}), ...evidence });
          continue;
        }

        const sourceBefore = await this.sampleFirmwareEvidence(direction.sourceBoardId, profile, "tx");
        const targetBefore = await this.sampleFirmwareEvidence(direction.targetBoardId, profile, "rx");
        let requestedCapture;
        if (profile.trafficMode === "adapter-injected") {
          requestedCapture = await adapter.send({ sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId, frame });
        } else if (profile.trafficMode === "firmware-driven") {
          await this.triggerFirmwareTraffic(direction.sourceBoardId, profile);
        }
        const busCapture = await adapter.waitForFrame({
          filter: { id: frame.id, extended: frame.extended, payload: frame.data, sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId },
          timeoutMs: profile.timeoutMs,
          signal: [...this.pending.values()].flatMap(entry => [...entry.contexts.values()]).find(context => context.jobId === jobId)?.signal
        });
        const sourceAfter = await this.sampleFirmwareEvidence(direction.sourceBoardId, profile, "tx");
        const targetAfter = await this.sampleFirmwareEvidence(direction.targetBoardId, profile, "rx");
        const firmwareTx = combineFirmwareSamples(sourceBefore, sourceAfter, "tx");
        const firmwareRx = combineFirmwareSamples(targetBefore, targetAfter, "rx");
        const application = await this.evaluateApplicationAssertions(direction.targetBoardId, profile);
        const evidence = evaluateCanDirectionEvidence({
          trafficMode: profile.trafficMode,
          simulation: false,
          expectedFrame: frame,
          firmwareTx,
          busCapture,
          firmwareRx,
          applicationAssertionsRequested: application.requested,
          applicationMatched: application.matched
        });
        if (direction.expectDelivery !== evidence.passed) {
          throw new DebugMcpError("CanFrameMismatch", "CAN firmware/bus/peer evidence did not match the direction expectation", { direction, expectedDelivery: direction.expectDelivery, evidence, firmwareTx, busCapture, firmwareRx, application });
        }
        frames.push({ frame, ...(requestedCapture ? { requested: requestedCapture } : {}), firmwareTx, busCapture, firmwareRx, application, ...evidence });
      }
      const result = { direction: { sourceBoardId: direction.sourceBoardId, targetBoardId: direction.targetBoardId }, expectDelivery: direction.expectDelivery, frames };
      directionResults.push(result);
      this.record(jobId, groupId, "DIRECTION", "PASSED", result);
    }
    return directionResults;
  }

  private async assertFirmwareCanReady(entry: PendingCanRun, profile: CanAcceptanceProfile): Promise<Record<string, unknown>> {
    const evidence: Record<string, unknown> = {};
    for (const boardId of entry.participants) {
      const mapping = this.mappingForBoard(boardId, profile);
      if (!mapping?.canReady || !mapping.busOffCount) {
        throw new DebugMcpError("CanDebugObservationFailed", "ALL_CAN_READY requires canReady and busOffCount firmware mappings", { boardId, missingExpressions: [!mapping?.canReady ? "canReady" : undefined, !mapping?.busOffCount ? "busOffCount" : undefined].filter(Boolean) });
      }
      const values = await this.evaluateExpressions(boardId, mapping.coreId, [mapping.canReady, mapping.busOffCount, ...(mapping.peerOnline ? [mapping.peerOnline] : []), ...(mapping.heartbeat ? [mapping.heartbeat] : [])]);
      const canReady = truthy(values[mapping.canReady]);
      const busOffCount = numeric(values[mapping.busOffCount]);
      if (!canReady || busOffCount !== 0) throw new DebugMcpError("CanDebugObservationFailed", "Firmware CAN readiness assertion failed", { boardId, canReady, busOffCount, values });
      evidence[boardId] = { status: "SUPPORTED", canReady, busOffCount, ...(mapping.peerOnline ? { peerOnline: values[mapping.peerOnline] } : {}), ...(mapping.heartbeat ? { heartbeat: values[mapping.heartbeat] } : {}) };
    }
    return evidence;
  }

  private mappingForBoard(boardId: string, profile: CanAcceptanceProfile): CanAcceptanceProfile["firmwareEvidence"]["PRIMARY"] {
    const role = profile.roles.find(item => item.boardId === boardId)?.role;
    return role === "SECONDARY" ? profile.firmwareEvidence.SECONDARY : profile.firmwareEvidence.PRIMARY;
  }

  private async sampleFirmwareEvidence(boardId: string, profile: CanAcceptanceProfile, side: "tx" | "rx"): Promise<FirmwareCanEvidence> {
    const mapping = this.mappingForBoard(boardId, profile);
    if (!mapping) return { status: "UNSUPPORTED", missingExpressions: ["firmwareEvidence mapping"] };
    const names = side === "tx"
      ? [mapping.txCount, mapping.txSequence, mapping.lastTxId, ...(mapping.lastTxPayload ?? []), mapping.controllerState]
      : [mapping.rxCount, mapping.rxSequence, mapping.lastRxId, ...(mapping.lastRxPayload ?? []), mapping.crcErrorCount, mapping.sequenceErrorCount, mapping.peerOnline, mapping.testResult];
    const expressions = names.filter((value): value is string => Boolean(value));
    const required = side === "tx"
      ? [mapping.txCount, mapping.lastTxId, ...(mapping.lastTxPayload ?? [])]
      : [mapping.rxCount, mapping.lastRxId, ...(mapping.lastRxPayload ?? [])];
    const missingExpressions = required.some(value => !value) || (side === "tx" ? !mapping.lastTxPayload?.length : !mapping.lastRxPayload?.length)
      ? [`${side}Count`, `last${side === "tx" ? "Tx" : "Rx"}Id`, `last${side === "tx" ? "Tx" : "Rx"}Payload`].filter(label =>
        label.endsWith("Count") ? !(side === "tx" ? mapping.txCount : mapping.rxCount) :
        label.endsWith("Id") ? !(side === "tx" ? mapping.lastTxId : mapping.lastRxId) :
        !(side === "tx" ? mapping.lastTxPayload?.length : mapping.lastRxPayload?.length)
      )
      : [];
    if (missingExpressions.length) return { status: "UNSUPPORTED", missingExpressions };
    const values = await this.evaluateExpressions(boardId, mapping.coreId, expressions);
    return side === "tx" ? {
      status: "SUPPORTED", txCountAfter: numeric(values[mapping.txCount!]), txSequence: optionalNumeric(values[mapping.txSequence ?? ""]),
      txCanId: numeric(values[mapping.lastTxId!]), txPayload: mapping.lastTxPayload!.map(expression => numeric(values[expression])),
      controllerState: mapping.controllerState ? values[mapping.controllerState] : undefined
    } : {
      status: "SUPPORTED", rxCountAfter: numeric(values[mapping.rxCount!]), rxSequence: optionalNumeric(values[mapping.rxSequence ?? ""]),
      lastRxCanId: numeric(values[mapping.lastRxId!]), lastRxPayload: mapping.lastRxPayload!.map(expression => numeric(values[expression])),
      crcErrorCount: optionalNumeric(values[mapping.crcErrorCount ?? ""]), sequenceErrorCount: optionalNumeric(values[mapping.sequenceErrorCount ?? ""]),
      peerOnline: mapping.peerOnline ? values[mapping.peerOnline] : undefined, processingResult: mapping.testResult ? values[mapping.testResult] : undefined
    };
  }

  private async triggerFirmwareTraffic(boardId: string, profile: CanAcceptanceProfile): Promise<void> {
    const mapping = this.mappingForBoard(boardId, profile);
    if (!mapping?.testTrigger) throw new DebugMcpError("CanDebugObservationFailed", "Firmware-driven traffic requires a testTrigger mapping", { boardId, missingExpressions: ["testTrigger"] });
    const context = [...this.pending.values()].flatMap(entry => [...entry.contexts.values()]).find(item => item.boardId === boardId);
    if (!context?.sessionId) throw new DebugMcpError("CanDebugObservationFailed", "Firmware trigger has no active board session", { boardId });
    const result = await this.options.tools.invokeTool("c2000_assignExpression", { sessionId: context.sessionId, coreId: mapping.coreId, expression: mapping.testTrigger, value: 1, verify: true, ...(context.leaseContext ? { __leaseContext: context.leaseContext } : {}) });
    assertSuccess(result, "Could not trigger firmware CAN traffic", { boardId, expression: mapping.testTrigger });
  }

  private async evaluateApplicationAssertions(boardId: string, profile: CanAcceptanceProfile): Promise<{ requested: boolean; matched?: boolean; assertions: Record<string, unknown>[] }> {
    const group = [...this.pending.values()].find(entry => entry.contexts.has(boardId));
    const role = profile.roles.find(item => item.boardId === boardId)?.role ?? (group?.participants.indexOf(boardId) === 1 ? "SECONDARY" : "PRIMARY");
    const requested = profile.applicationAssertions.filter(assertion => assertion.boardRole === role);
    const assertions: Record<string, unknown>[] = [];
    for (const assertion of requested) {
      const values = await this.evaluateExpressions(boardId, assertion.coreId, [assertion.expression]);
      const actual = values[assertion.expression];
      assertions.push({ ...assertion, actual, matched: compareValue(actual, assertion.expected, assertion.comparison) });
    }
    return { requested: requested.length > 0, ...(requested.length ? { matched: assertions.every(item => item.matched === true) } : {}), assertions };
  }

  private async evaluateExpressions(boardId: string, coreId: number, expressions: string[]): Promise<Record<string, unknown>> {
    const context = [...this.pending.values()].flatMap(entry => [...entry.contexts.values()]).find(item => item.boardId === boardId);
    if (!context?.sessionId) throw new DebugMcpError("CanDebugObservationFailed", "Firmware evidence has no active board session", { boardId });
    const result = await this.options.tools.invokeTool("c2000_evaluateMany", { sessionId: context.sessionId, coreId, expressions, ...(context.leaseContext ? { __leaseContext: context.leaseContext } : {}) });
    assertSuccess(result, "CAN firmware evidence read failed", { boardId, coreId, expressions });
    const items = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : [];
    const failed = expressions.filter(expression => !items.some(item => item.expression === expression && item.success !== false));
    if (failed.length) throw new DebugMcpError("CanDebugObservationFailed", "CAN firmware evidence expression is unavailable", { boardId, coreId, missingExpressions: failed, result });
    return Object.fromEntries(items.map(item => [String(item.expression), item.value]));
  }

  private async inspectLaunchEvidence(entry: PendingCanRun, plan: TestPlan, coreIds: number[]): Promise<Record<string, { connected: Record<string, unknown>; halted: Record<string, unknown>; loaded: Record<string, unknown> }>> {
    const output: Record<string, { connected: Record<string, unknown>; halted: Record<string, unknown>; loaded: Record<string, unknown> }> = {};
    for (const boardId of entry.participants) {
      const context = requireContext(entry, boardId);
      const states = await Promise.all(coreIds.map(coreId => this.invokeBoardRead(context, "c2000_getTargetState", { sessionId: context.sessionId, coreId })));
      if (states.some(state => state.success !== true || state.connected !== true)) throw new DebugMcpError("CanDebugObservationFailed", "ALL_CONNECTED actual core-state assertion failed", { boardId, states });
      if (states.some(state => String(state.state).toLowerCase() !== "halted")) throw new DebugMcpError("CanDebugObservationFailed", "ALL_HALTED actual core-state assertion failed", { boardId, states });
      const artifacts = resolveArtifactsForBoard(plan, boardId);
      const expectedPrograms = new Map<number, string>([[0, artifacts?.cpu1OutPath ?? ""], [2, artifacts?.cpu2OutPath ?? ""]]);
      const loaded = await Promise.all(coreIds.map(coreId => this.invokeBoardRead(context, "c2000_getLoadedProgramInfo", { sessionId: context.sessionId, coreId })));
      const mismatches = loaded.filter(item => {
        const expected = expectedPrograms.get(Number(item.coreId));
        return expected && (item.success !== true || item.programUri !== expected || typeof item.sha256 !== "string" || typeof item.fileSize !== "number" || typeof item.fileMTime !== "string");
      });
      if (mismatches.length) throw new DebugMcpError("CanDebugObservationFailed", "ALL_LOADED trusted ELF metadata assertion failed", { boardId, expectedPrograms: Object.fromEntries(expectedPrograms), loaded, mismatches });
      output[boardId] = {
        connected: { connected: true, cores: states },
        halted: { halted: true, cores: states },
        loaded: { loaded: true, programs: loaded }
      };
    }
    return output;
  }

  private async inspectRunningEvidence(entry: PendingCanRun, coreIds: number[]): Promise<Record<string, Record<string, unknown>>> {
    const output: Record<string, Record<string, unknown>> = {};
    const samples: Array<{ boardId: string; sampledAt: string }> = [];
    for (const boardId of entry.participants) {
      const context = requireContext(entry, boardId);
      const states = await Promise.all(coreIds.map(coreId => this.invokeBoardRead(context, "c2000_getTargetState", { sessionId: context.sessionId, coreId })));
      const sampledAt = new Date().toISOString();
      samples.push({ boardId, sampledAt });
      if (states.some(state => state.success !== true || String(state.state).toLowerCase() !== "running")) throw new DebugMcpError("CanDebugObservationFailed", "ALL_RUNNING actual core-state assertion failed", { boardId, states });
      output[boardId] = { running: true, cores: states, sampledAt };
    }
    const times = samples.map(item => Date.parse(item.sampledAt));
    const maxSkewMs = times.length ? Math.max(...times) - Math.min(...times) : 0;
    for (const value of Object.values(output)) value.runCommandSkewMs = maxSkewMs;
    return output;
  }

  private invokeBoardRead(context: CanStepContext, toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.options.tools.invokeTool(toolName, { ...input, ...(context.leaseContext ? { __leaseContext: context.leaseContext } : {}) });
  }
}

function exceedsHealthBudget(health: { maxConsecutiveFailures?: number; maxFailureRate?: number }, consecutiveFailures: number, failureRate: number): boolean {
  return (health.maxConsecutiveFailures !== undefined && consecutiveFailures > health.maxConsecutiveFailures)
    || (health.maxFailureRate !== undefined && failureRate > health.maxFailureRate);
}

function requireContext(entry: PendingCanRun, boardId: string): CanStepContext {
  const context = entry.contexts.get(boardId);
  if (!context) throw new DebugMcpError("BoardGroupBarrierFailed", "CAN group is missing a participant context", { boardId, participants: entry.participants });
  return context;
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

function combineFirmwareSamples(before: FirmwareCanEvidence, after: FirmwareCanEvidence, side: "tx" | "rx"): FirmwareCanEvidence {
  if (before.status === "UNSUPPORTED" || after.status === "UNSUPPORTED") return { status: "UNSUPPORTED", missingExpressions: [...(before.missingExpressions ?? []), ...(after.missingExpressions ?? [])] };
  return side === "tx"
    ? { ...after, txCountBefore: before.txCountAfter, txCountDelta: (after.txCountAfter ?? 0) - (before.txCountAfter ?? 0), txTimestamp: new Date().toISOString() }
    : { ...after, rxCountBefore: before.rxCountAfter, rxCountDelta: (after.rxCountAfter ?? 0) - (before.rxCountAfter ?? 0) };
}
function numeric(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function optionalNumeric(value: unknown): number | undefined { return value === undefined ? undefined : numeric(value); }
function truthy(value: unknown): boolean { return value === true || value === 1 || value === "1" || value === "true"; }
function compareValue(actual: unknown, expected: unknown, comparison: string): boolean {
  switch (comparison) {
    case "EQUAL": return actual === expected;
    case "NOT_EQUAL": return actual !== expected;
    case "GREATER_THAN": return numeric(actual) > numeric(expected);
    case "GREATER_THAN_OR_EQUAL": return numeric(actual) >= numeric(expected);
    case "LESS_THAN": return numeric(actual) < numeric(expected);
    case "LESS_THAN_OR_EQUAL": return numeric(actual) <= numeric(expected);
    case "BOOLEAN": return truthy(actual) === truthy(expected);
    default: return false;
  }
}

function errorRecord(error: ReturnType<typeof toStructuredError>): Record<string, unknown> {
  return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
}

function toErrorRecord(error: unknown): Record<string, unknown> { return errorRecord(toStructuredError(error)); }
function campaignType(mode: NonNullable<TestPlan["can"]>["execution"]["mode"]): CanCampaignType {
  return mode === "fault_campaign" ? "FAULT_CAMPAIGN" : mode === "matrix" ? "MATRIX" : mode === "soak" ? "SOAK" : "FAULT_CAMPAIGN";
}

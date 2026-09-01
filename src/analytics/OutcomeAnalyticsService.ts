import { randomUUID } from "node:crypto";
import type { Logger } from "../utils/logger.js";
import type { CapabilityAuditEvent, ToolCapability } from "../mcp/capabilities.js";
import {
  c2000ToolDefinitions,
  definitionsForSafetyProfile,
  type ToolDefinition,
  type ToolProfile,
  type ToolSurfaceProfile
} from "../mcp/tools.js";
import { toStructuredError } from "../utils/errors.js";
import { deterministicStatistics } from "./DeterministicStatistics.js";
import { classifyOutcomeFailure } from "./OutcomeFailureClassifier.js";
import {
  ANALYTICS_WINDOWS,
  OUTCOME_FAILURE_CLASSES,
  outcomeEventMetadataSchema,
  outcomeEventSchema,
  type AnalyticsWindow,
  type OutcomeEvent,
  type OutcomeEventKind,
  type OutcomeFailureClass,
  type OutcomeStatus
} from "./OutcomeSchemas.js";
import type { OutcomeEventStore } from "./OutcomeEventRepository.js";

export const OUTCOME_ANALYTICS_RETENTION_DAYS = 90;
export const DEFAULT_OUTCOME_ANALYTICS_WINDOW: AnalyticsWindow = "7d";
export const MIN_HISTORICAL_RECOMMENDATION_CASES = 5;
const MAX_ANALYTICS_EVENTS = 50_000;
const MAX_RECOMMENDATION_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ASSOCIATION_MS = 30 * 60 * 1000;

export interface OutcomeAnalyticsServiceOptions {
  repository: OutcomeEventStore;
  toolProfile: ToolProfile | (() => ToolProfile);
  toolSurfaceProfile: ToolSurfaceProfile | (() => ToolSurfaceProfile);
  activeCapabilities?: () => readonly ToolCapability[];
  now?: () => number;
  retentionDays?: number;
  logger?: Pick<Logger, "warn" | "error">;
}

export interface ToolInvocationOutcomeInput {
  toolName: string;
  input?: unknown;
  result?: Record<string, unknown>;
  error?: unknown;
  durationMs: number;
}

export interface WorkflowAnalyticsInput {
  window?: AnalyticsWindow;
  workflow?: string;
}

export interface ToolAnalyticsInput {
  window?: AnalyticsWindow;
  tool?: string;
  family?: string;
  role?: string;
  exposure?: string;
  capability?: ToolCapability;
}

export interface CapabilityAnalyticsInput {
  window?: AnalyticsWindow;
  capability?: ToolCapability;
}

export interface EscalationRecommendationInput {
  workflow?: string;
  stage?: string;
  errorCode?: string;
  failureClass?: string;
  jobId?: string;
}

interface FailureContext {
  failureClass: OutcomeFailureClass;
  stage?: string;
  errorCode?: string;
  workflow?: string;
  jobId?: string;
}

interface CapabilityRule {
  capability: ToolCapability;
  reason: string;
  failureClasses: readonly OutcomeFailureClass[];
  stagePattern?: RegExp;
  baseConfidence: number;
}

const CAPABILITY_RULES: readonly CapabilityRule[] = [
  {
    capability: "debug.manual",
    reason: "The failure points to a connection, core-state, boot-handoff, or IPC control problem that may need a bounded manual per-core inspection.",
    failureClasses: ["connection", "core-state", "boot-handoff", "ipc-timeout"],
    baseConfidence: 0.62
  },
  {
    capability: "debug.program",
    reason: "The failure points to program or symbol loading, or to a protected resident-image reload path.",
    failureClasses: ["program-load", "flash-protection"],
    baseConfidence: 0.64
  },
  {
    capability: "debug.wait",
    reason: "The failure is expression-oriented and may need a bounded generic wait or condition inspection.",
    failureClasses: ["expression"],
    baseConfidence: 0.58
  },
  {
    capability: "observability.variables",
    reason: "The request is consistent with a bounded low-rate variable trend or state monitor.",
    failureClasses: ["expression", "ipc-timeout"],
    stagePattern: /trend|variable|monitor|sample/i,
    baseConfidence: 0.55
  },
  {
    capability: "observability.dlog",
    reason: "Existing target-side DLOG evidence may explain the failure without arming or changing firmware.",
    failureClasses: ["dlog"],
    stagePattern: /dlog|capture/i,
    baseConfidence: 0.68
  },
  {
    capability: "observability.erad",
    reason: "The request is about execution timing, ISR cycles, or fenced ERAD profiling.",
    failureClasses: ["core-state", "expression"],
    stagePattern: /erad|timing|cycle|isr|profile/i,
    baseConfidence: 0.57
  },
  {
    capability: "can.advanced",
    reason: "The failure belongs to a specialized multi-board CAN campaign or soak workflow.",
    failureClasses: ["can"],
    stagePattern: /can|soak|campaign|bus/i,
    baseConfidence: 0.66
  }
];

/**
 * Best-effort, bounded analytics for the MCP exposure layer. It never owns a
 * target, a worker, or a debug session, and all write failures are isolated
 * from the debug path.
 */
export class OutcomeAnalyticsService {
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly logger?: Pick<Logger, "warn" | "error">;

  constructor(private readonly options: OutcomeAnalyticsServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.retentionDays = Math.max(1, Math.min(3650, Math.trunc(options.retentionDays ?? OUTCOME_ANALYTICS_RETENTION_DAYS)));
    this.logger = options.logger;
  }

  /** Record an already-normalized event. Analytics persistence is optional. */
  record(event: Omit<OutcomeEvent, "eventId" | "timestamp" | "toolProfile" | "toolSurfaceProfile" | "activeCapabilities"> & Partial<Pick<OutcomeEvent, "timestamp" | "toolProfile" | "toolSurfaceProfile" | "activeCapabilities">>): boolean {
    try {
      const normalized = sanitizeOutcomeEvent({
        ...event,
        eventId: "eventId" in event && typeof event.eventId === "string" ? event.eventId : randomUUID(),
        timestamp: event.timestamp ?? new Date(this.now()).toISOString(),
        toolProfile: event.toolProfile ?? this.currentProfile(),
        toolSurfaceProfile: event.toolSurfaceProfile ?? this.currentSurface(),
        activeCapabilities: event.activeCapabilities ?? this.currentCapabilities()
      });
      this.options.repository.append(normalized);
      return true;
    } catch (error) {
      this.analyticsWriteFailure("record", error);
      return false;
    }
  }

  /** Accepts only the sanitized event shape used by the proxy-to-daemon audit RPC. */
  recordExternalEvent(value: unknown): boolean {
    const parsed = outcomeEventSchema.safeParse(value);
    if (!parsed.success) {
      this.logger?.warn("c2000 analytics event rejected", { reason: "schema-validation" });
      return false;
    }
    return this.record(parsed.data);
  }

  recordToolInvocation(input: ToolInvocationOutcomeInput): void {
    try {
      const definition = c2000ToolDefinitions.find(candidate => candidate.name === input.toolName);
      const result = input.result;
      const structured = input.error
        ? toStructuredError(input.error)
        : result?.success === false
          ? structuredResultError(result)
          : undefined;
      const failure = structured
        ? classifyOutcomeFailure(structured)
        : undefined;
      const outcome = outcomeFor(result, structured);
      const common = {
        name: input.toolName,
        outcome,
        durationMs: boundedDuration(input.durationMs),
        ...(failure?.stage ? { stage: failure.stage } : {}),
        ...(structured?.code ? { errorCode: boundedLabel(structured.code) } : {}),
        ...(failure ? { failureClass: failure.failureClass } : {}),
        ...correlationFields(input.input, result),
        metadata: definition ? toolMetadata(definition, result) : {}
      } as const;
      this.record({ kind: "tool_invocation", ...common });
      if (definition?.role === "workflow") {
        this.record({ kind: "workflow_run", ...common });
      }
    } catch (error) {
      this.analyticsWriteFailure("tool-invocation", error);
    }
  }

  recordCapabilityAudit(event: CapabilityAuditEvent): void {
    try {
      const kind: OutcomeEventKind = event.action === "open"
        ? "capability_open"
        : event.action === "close"
          ? "capability_close"
          : "capability_expire";
      const durationMs = event.action === "open"
        ? undefined
        : Math.max(0, Date.parse(event.timestamp ?? event.expiresAt) - Date.parse(event.createdAt));
      this.record({
        kind,
        name: event.capability,
        outcome: event.action === "expire" ? "timeout" : "success",
        ...(durationMs === undefined ? {} : { durationMs }),
        sessionId: event.sessionId,
        ...(event.openedFrom?.workflow ? { escalationFrom: event.openedFrom.workflow } : event.openedFrom?.failureClass ? { escalationFrom: event.openedFrom.failureClass } : {}),
        escalationTo: event.capability,
        ...(event.openedFrom?.jobId ? { jobId: event.openedFrom.jobId } : {}),
        metadata: {
          ...(event.recommendationId ? { recommendationId: event.recommendationId } : {}),
          ...(event.outcome ? { sessionOutcome: event.outcome } : {}),
          ...(event.openedFrom ? { openedFrom: event.openedFrom } : {}),
          actor: event.actor
        }
      });
    } catch (error) {
      this.analyticsWriteFailure("capability-audit", error);
    }
  }

  async maintain(): Promise<{ deleted: number; available: boolean }> {
    try {
      const cutoff = new Date(this.now() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      return { deleted: this.options.repository.deleteBefore(cutoff), available: true };
    } catch (error) {
      this.analyticsWriteFailure("retention", error);
      return { deleted: 0, available: false };
    }
  }

  getWorkflowAnalytics(input: WorkflowAnalyticsInput = {}): Record<string, unknown> {
    return this.withAnalyticsQuery(input.window, events => {
      const filtered = events
        .filter(event => event.kind === "workflow_run")
        .filter(event => !input.workflow || event.name === input.workflow);
      const grouped = groupBy(filtered, event => event.name);
      return {
        workflows: Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([workflow, rows]) => ({
          workflow,
          runs: rows.length,
          ...outcomeSummary(rows),
          duration: deterministicStatistics(rows.map(row => row.durationMs)),
          topFailures: topLabels(rows.map(row => row.failureClass)),
          topStages: topLabels(rows.map(row => row.stage)),
          domainVerdicts: topLabels(rows.map(row => metadataString(row, "domainVerdict"))),
          lastUsed: rows.at(-1)?.timestamp
        }))
      };
    });
  }

  getToolAnalytics(input: ToolAnalyticsInput = {}): Record<string, unknown> {
    return this.withAnalyticsQuery(input.window, events => {
      const filtered = events
        .filter(event => event.kind === "tool_invocation")
        .filter(event => !input.tool || event.name === input.tool)
        .filter(event => !input.family || metadataString(event, "family") === input.family)
        .filter(event => !input.role || metadataString(event, "role") === input.role)
        .filter(event => !input.exposure || metadataString(event, "exposure") === input.exposure)
        .filter(event => !input.capability || metadataString(event, "capability") === input.capability);
      const tools = Array.from(groupBy(filtered, event => event.name).entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tool, rows]) => ({
          tool,
          family: metadataString(rows[0], "family"),
          role: metadataString(rows[0], "role"),
          exposure: metadataString(rows[0], "exposure"),
          capability: metadataString(rows[0], "capability"),
          ...outcomeSummary(rows),
          duration: deterministicStatistics(rows.map(row => row.durationMs)),
          domainVerdicts: topLabels(rows.map(row => metadataString(row, "domainVerdict"))),
          lastUsed: rows.at(-1)?.timestamp
        }));
      return {
        tools,
        byFamily: dimensionSummary(filtered, event => metadataString(event, "family")),
        byRole: dimensionSummary(filtered, event => metadataString(event, "role")),
        byExposure: dimensionSummary(filtered, event => metadataString(event, "exposure")),
        byCapability: dimensionSummary(filtered, event => metadataString(event, "capability")),
        byEffect: dimensionSummary(filtered, event => metadataStringArray(event, "effects").join("\u0000"), key => key.split("\u0000").filter(Boolean))
      };
    });
  }

  getCapabilityAnalytics(input: CapabilityAnalyticsInput = {}): Record<string, unknown> {
    return this.withAnalyticsQuery(input.window, events => {
      const capabilityNames = input.capability
        ? [input.capability]
        : Array.from(new Set(events.filter(event => event.kind.startsWith("capability_")).map(event => event.name))).filter(isToolCapability);
      const rows = capabilityNames.sort().map(capability => capabilitySummary(capability, events, this.now()));
      const recommendations = events.filter(event => event.kind === "escalation_recommendation");
      const recommendationAccepted = events.filter(event => event.kind === "capability_open" && Boolean(metadataString(event, "recommendationId")));
      return {
        associationNote: "Capability-to-continuation relationships are observational associations, not causal measurements.",
        recommendationAnalytics: {
          recommendationsGenerated: recommendations.length,
          recommendationsAccepted: recommendationAccepted.length,
          capabilityOpenedFromRecommendation: recommendationAccepted.length
        },
        capabilities: rows
      };
    });
  }

  getEscalationRecommendations(input: EscalationRecommendationInput = {}): Record<string, unknown> {
    const eventsResult = this.queryWindow("30d");
    const context = this.resolveFailureContext(input, eventsResult.events);
    const active = new Set(this.currentCapabilities());
    const safetyDefinitions = definitionsForSafetyProfile(this.currentProfile());
    const candidates = CAPABILITY_RULES.filter(rule => rule.failureClasses.includes(context.failureClass))
      .filter(rule => !rule.stagePattern || !context.stage || rule.stagePattern.test(context.stage));
    const recommendations = candidates.flatMap(rule => {
      const members = c2000ToolDefinitions.filter(tool => tool.capability === rule.capability);
      const allowed = members.filter(tool => safetyDefinitions.some(candidate => candidate.name === tool.name));
      if (allowed.length === 0) return [];
      const evidence = historicalEvidence(rule.capability, context, eventsResult.events);
      const supported = evidence.matchingCases >= MIN_HISTORICAL_RECOMMENDATION_CASES;
      const alreadyActive = active.has(rule.capability) || this.currentSurface() !== "agent";
      const recommendationId = randomUUID();
      const source = supported ? "static-and-history" : "static-rule";
      const recommendation = {
        recommendationId,
        capability: rule.capability,
        reason: context.stage ? `${rule.reason} Observed stage: ${context.stage}.` : rule.reason,
        source,
        confidence: supported ? Math.min(0.95, rule.baseConfidence + (evidence.followedBySuccess / Math.max(1, evidence.matchingCases)) * 0.25) : rule.baseConfidence,
        historicalEvidence: {
          matchingCases: evidence.matchingCases,
          followedBySuccess: evidence.followedBySuccess,
          ...(supported ? {} : { insufficientHistoricalSupport: true })
        },
        safetyAllowed: true,
        blockedBySafety: members.filter(tool => !safetyDefinitions.some(candidate => candidate.name === tool.name)).map(tool => tool.name),
        alreadyActive,
        visibleTools: allowed.map(tool => tool.name)
      };
      this.record({
        kind: "escalation_recommendation",
        name: recommendationId,
        outcome: "success",
        ...(context.errorCode ? { errorCode: context.errorCode } : {}),
        failureClass: context.failureClass,
        ...(context.workflow ? { escalationFrom: context.workflow } : { escalationFrom: context.failureClass }),
        escalationTo: rule.capability,
        jobId: context.jobId,
        metadata: {
          recommendationId,
          recommendationSource: source,
          recommendationConfidence: recommendation.confidence,
          matchingCases: evidence.matchingCases,
          followedBySuccess: evidence.followedBySuccess,
          ...(supported ? {} : { insufficientHistoricalSupport: true })
        }
      });
      return [{
        recommendation,
        stageMatch: rule.stagePattern && context.stage && rule.stagePattern.test(context.stage) ? 1 : 0,
        historicalSupport: supported ? 1 : 0,
        active: alreadyActive ? 1 : 0,
        memberCount: allowed.length
      }];
    })
      .sort((left, right) => right.stageMatch - left.stageMatch
        || right.historicalSupport - left.historicalSupport
        || left.active - right.active
        || left.memberCount - right.memberCount
        || left.recommendation.capability.localeCompare(right.recommendation.capability))
      .map(item => item.recommendation);
    return {
      analyticsAvailable: eventsResult.available,
      failure: context,
      activeToolProfile: this.currentProfile(),
      activeToolSurfaceProfile: this.currentSurface(),
      activeCapabilities: this.currentCapabilities(),
      recommendations,
    };
  }

  private resolveFailureContext(input: EscalationRecommendationInput, events: OutcomeEvent[] = []): FailureContext {
    const evidence = events
      .filter(event => event.kind === "workflow_run" || event.kind === "tool_invocation")
      .filter(event => event.outcome !== "success")
      .filter(event => !input.jobId || event.jobId === input.jobId)
      .filter(event => !input.workflow || event.name === input.workflow)
      .filter(event => Boolean(event.failureClass || event.errorCode || event.stage))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
    const failureClass = normalizeFailureClass(input.failureClass)
      ?? evidence?.failureClass
      ?? classifyOutcomeFailure({ code: input.errorCode ?? evidence?.errorCode, message: input.stage ?? evidence?.stage }).failureClass;
    return {
      failureClass,
      ...((boundedLabel(input.stage) ?? evidence?.stage) ? { stage: boundedLabel(input.stage) ?? evidence?.stage } : {}),
      ...((boundedLabel(input.errorCode) ?? evidence?.errorCode) ? { errorCode: boundedLabel(input.errorCode) ?? evidence?.errorCode } : {}),
      ...((boundedLabel(input.workflow) ?? (evidence?.kind === "workflow_run" ? evidence.name : undefined)) ? { workflow: boundedLabel(input.workflow) ?? evidence?.name } : {}),
      ...(boundedLabel(input.jobId) ? { jobId: boundedLabel(input.jobId) } : {})
    };
  }

  private withAnalyticsQuery(window: AnalyticsWindow | undefined, build: (events: OutcomeEvent[]) => Record<string, unknown>): Record<string, unknown> {
    const result = this.queryWindow(window ?? DEFAULT_OUTCOME_ANALYTICS_WINDOW);
    const body = build(result.events);
    return {
      analyticsAvailable: result.available,
      window: result.window,
      from: result.from,
      to: result.to,
      generatedAt: new Date(this.now()).toISOString(),
      retentionDays: this.retentionDays,
      activeToolProfile: this.currentProfile(),
      activeToolSurfaceProfile: this.currentSurface(),
      activeCapabilities: this.currentCapabilities(),
      ...body
    };
  }

  private queryWindow(window: AnalyticsWindow): { events: OutcomeEvent[]; available: boolean; window: AnalyticsWindow; from: string; to: string } {
    const normalized = ANALYTICS_WINDOWS.includes(window) ? window : DEFAULT_OUTCOME_ANALYTICS_WINDOW;
    const toMs = this.now();
    const durationMs = normalized === "24h"
      ? 24 * 60 * 60 * 1000
      : normalized === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : normalized === "30d"
          ? 30 * 24 * 60 * 60 * 1000
          : this.retentionDays * 24 * 60 * 60 * 1000;
    const from = new Date(toMs - durationMs).toISOString();
    const to = new Date(toMs).toISOString();
    void this.maintain();
    try {
      return { events: this.options.repository.list({ from, to, limit: MAX_ANALYTICS_EVENTS }), available: true, window: normalized, from, to };
    } catch (error) {
      this.analyticsWriteFailure("query", error);
      return { events: [], available: false, window: normalized, from, to };
    }
  }

  private currentProfile(): ToolProfile {
    return typeof this.options.toolProfile === "function" ? this.options.toolProfile() : this.options.toolProfile;
  }

  private currentSurface(): ToolSurfaceProfile {
    return typeof this.options.toolSurfaceProfile === "function" ? this.options.toolSurfaceProfile() : this.options.toolSurfaceProfile;
  }

  private currentCapabilities(): ToolCapability[] {
    return Array.from(new Set((this.options.activeCapabilities?.() ?? []).filter(isToolCapability)));
  }

  private analyticsWriteFailure(operation: string, error: unknown): void {
    this.logger?.warn("c2000 analytics persistence unavailable", {
      operation,
      errorCode: toStructuredError(error).code
    });
  }
}

export function capabilityAuditToOutcomeEvent(
  event: CapabilityAuditEvent,
  toolProfile: ToolProfile,
  toolSurfaceProfile: ToolSurfaceProfile,
  activeCapabilities: readonly ToolCapability[] = []
): OutcomeEvent {
  const kind: OutcomeEventKind = event.action === "open"
    ? "capability_open"
    : event.action === "close"
      ? "capability_close"
      : "capability_expire";
  return sanitizeOutcomeEvent({
    eventId: randomUUID(),
    timestamp: event.timestamp ?? event.createdAt,
    kind,
    name: event.capability,
    outcome: event.action === "expire" ? "timeout" : "success",
    durationMs: event.action === "open" ? undefined : Math.max(0, Date.parse(event.timestamp ?? event.expiresAt) - Date.parse(event.createdAt)),
    toolProfile,
    toolSurfaceProfile,
    activeCapabilities,
    sessionId: event.sessionId,
    ...(event.openedFrom?.workflow ? { escalationFrom: event.openedFrom.workflow } : event.openedFrom?.failureClass ? { escalationFrom: event.openedFrom.failureClass } : {}),
    escalationTo: event.capability,
    ...(event.openedFrom?.jobId ? { jobId: event.openedFrom.jobId } : {}),
    metadata: {
      ...(event.recommendationId ? { recommendationId: event.recommendationId } : {}),
      ...(event.outcome ? { sessionOutcome: event.outcome } : {}),
      ...(event.openedFrom ? { openedFrom: event.openedFrom } : {}),
      actor: event.actor
    }
  });
}

export function sanitizeOutcomeEvent(value: Record<string, unknown>): OutcomeEvent {
  const activeCapabilities = Array.isArray(value.activeCapabilities)
    ? value.activeCapabilities.filter(isToolCapability)
    : [];
  const metadata = sanitizeMetadata(value.metadata);
  const normalized = {
    eventId: typeof value.eventId === "string" && /^[0-9a-f-]{36}$/i.test(value.eventId) ? value.eventId : randomUUID(),
    timestamp: typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp)) ? new Date(value.timestamp).toISOString() : new Date().toISOString(),
    kind: value.kind,
    name: boundedLabel(value.name) ?? "unknown",
    outcome: value.outcome,
    ...(typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? { durationMs: Math.min(value.durationMs, 86_400_000) } : {}),
    ...(boundedLabel(value.stage) ? { stage: boundedLabel(value.stage) } : {}),
    ...(boundedLabel(value.errorCode) ? { errorCode: boundedLabel(value.errorCode) } : {}),
    ...(normalizeFailureClass(value.failureClass) ? { failureClass: normalizeFailureClass(value.failureClass) } : {}),
    toolProfile: value.toolProfile,
    toolSurfaceProfile: value.toolSurfaceProfile,
    activeCapabilities,
    ...(boundedNonNegativeInteger(value.boardCount) === undefined ? {} : { boardCount: boundedNonNegativeInteger(value.boardCount) }),
    ...(boundedNonNegativeInteger(value.coreCount) === undefined ? {} : { coreCount: boundedNonNegativeInteger(value.coreCount) }),
    ...(boundedLabel(value.jobId) ? { jobId: boundedLabel(value.jobId) } : {}),
    ...(boundedLabel(value.sessionId) ? { sessionId: boundedLabel(value.sessionId) } : {}),
    ...(boundedLabel(value.escalationFrom) ? { escalationFrom: boundedLabel(value.escalationFrom) } : {}),
    ...(isToolCapability(value.escalationTo) ? { escalationTo: value.escalationTo } : {}),
    metadata
  };
  return outcomeEventSchema.parse(normalized);
}

function toolMetadata(definition: ToolDefinition, result?: Record<string, unknown>): Record<string, unknown> {
  const domainVerdict = findDomainVerdict(result);
  return {
    role: definition.role,
    family: definition.family,
    exposure: definition.exposure,
    ...(definition.capability ? { capability: definition.capability } : {}),
    approvalClass: definition.approvalClass,
    effects: definition.effects,
    ...(domainVerdict ? { domainVerdict } : {})
  };
}

function correlationFields(input: unknown, result?: Record<string, unknown>): Record<string, unknown> {
  const values = asRecord(input);
  const resultValues = asRecord(result);
  const boardCount = arrayLength(values.boardIds) ?? arrayLength(values.boards) ?? arrayLength(values.boardGroup);
  const coreCount = arrayLength(values.coreIds) ?? arrayLength(values.cores) ?? arrayLength(values.programs) ?? arrayLength(values.assignments) ?? arrayLength(values.conditions);
  const jobId = boundedLabel(values.jobId) ?? boundedLabel(resultValues.jobId);
  const sessionId = boundedLabel(values.sessionId) ?? boundedLabel(resultValues.sessionId);
  return {
    ...(boardCount === undefined ? {} : { boardCount }),
    ...(coreCount === undefined ? {} : { coreCount }),
    ...(jobId ? { jobId } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

function outcomeFor(result?: Record<string, unknown>, error?: { code?: string; message?: string }): OutcomeStatus {
  const code = error?.code?.toLowerCase() ?? "";
  const status = typeof result?.status === "string" ? result.status.toLowerCase() : "";
  if (/cancel/.test(code) || /cancel/.test(status)) return "cancelled";
  if (/timeout/.test(code) || /timeout/.test(status)) return "timeout";
  if (/capability|required|safety|lease|quarantine/.test(code)) return "blocked";
  if (result?.success === true) return "success";
  if (result?.success === false || error) return "failure";
  return "unknown";
}

function structuredResultError(result: Record<string, unknown>): { code?: string; message?: string; details?: Record<string, unknown> } {
  const error = asRecord(result.error);
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(asRecord(error.details) ? { details: asRecord(error.details) } : {})
  };
}

function findDomainVerdict(result?: Record<string, unknown>): string | undefined {
  const candidates = [
    result?.verdict,
    result?.overallStatus,
    asRecord(result?.acceptanceSummary).verdict,
    asRecord(result?.acceptanceSummary).overallStatus,
    asRecord(result?.summary).verdict,
    asRecord(result?.summary).overallStatus
  ];
  return candidates.find(value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value)) as string | undefined;
}

function capabilitySummary(capability: string, events: OutcomeEvent[], nowMs: number): Record<string, unknown> {
  const lifecycle = events.filter(event => event.name === capability && event.kind.startsWith("capability_"));
  const opens = lifecycle.filter(event => event.kind === "capability_open");
  const closes = lifecycle.filter(event => event.kind === "capability_close");
  const expires = lifecycle.filter(event => event.kind === "capability_expire");
  const durations: number[] = [];
  let activeCount = 0;
  let unusedCount = 0;
  let openedAfterWorkflowFailure = 0;
  let continuationCount = 0;
  let continuationSuccessCount = 0;
  const precedingFailures: string[] = [];
  const usedTools: string[] = [];
  const escalationPaths: Array<Record<string, unknown>> = [];
  for (const open of opens) {
    const end = lifecycle
      .filter(event => event.sessionId === open.sessionId && (event.kind === "capability_close" || event.kind === "capability_expire") && event.timestamp >= open.timestamp)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0];
    const endMs = end ? Date.parse(end.timestamp) : nowMs;
    const duration = Math.max(0, endMs - Date.parse(open.timestamp));
    durations.push(duration);
    if (!end) activeCount += 1;
    const tools = events.filter(event => event.kind === "tool_invocation"
      && event.timestamp >= open.timestamp
      && Date.parse(event.timestamp) <= endMs
      && metadataString(event, "capability") === capability);
    usedTools.push(...tools.map(event => event.name));
    if (tools.length === 0) unusedCount += 1;
    const openedFrom = metadataRecord(open, "openedFrom");
    if (typeof openedFrom.failureClass === "string") precedingFailures.push(openedFrom.failureClass);
    const prior = events
      .filter(event => event.kind === "workflow_run" && event.outcome !== "success" && event.timestamp <= open.timestamp)
      .filter(event => Date.parse(open.timestamp) - Date.parse(event.timestamp) <= MAX_ASSOCIATION_MS)
      .filter(event => !openedFrom.jobId || event.jobId === openedFrom.jobId)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
    if (prior?.failureClass) precedingFailures.push(prior.failureClass);
    const precedingFailure = typeof openedFrom.failureClass === "string" ? openedFrom.failureClass : prior?.failureClass;
    if (precedingFailure) openedAfterWorkflowFailure += 1;

    const continuation = events.filter(event => event.kind === "workflow_run"
      && event.timestamp > open.timestamp
      && Date.parse(event.timestamp) <= endMs + MAX_ASSOCIATION_MS
      && (typeof openedFrom.workflow !== "string" || event.name === openedFrom.workflow)
      && (typeof openedFrom.jobId !== "string" || event.jobId === openedFrom.jobId));
    if (continuation.length > 0) {
      continuationCount += 1;
      if (continuation.some(event => event.outcome === "success")) continuationSuccessCount += 1;
    }
    escalationPaths.push({
      ...(openedFrom.workflow ? { workflow: openedFrom.workflow } : {}),
      ...(precedingFailure ? { failureClass: precedingFailure } : {}),
      capability,
      tools: Array.from(new Set(tools.map(event => event.name))).slice(0, 20),
      associatedContinuation: continuation.length > 0,
      continuationSucceeded: continuation.some(event => event.outcome === "success")
    });
  }
  return {
    capability,
    opens: opens.length,
    closes: closes.length,
    expires: expires.length,
    active: activeCount,
    unused: unusedCount,
    openedAfterWorkflowFailure,
    activeDuration: deterministicStatistics(durations),
    topTools: topLabels(usedTools),
    commonPrecedingFailures: topLabels(precedingFailures),
    escalationPaths: escalationPaths.slice(0, 20),
    continuationSuccessRate: continuationCount === 0 ? null : continuationSuccessCount / continuationCount,
    continuationCases: continuationCount,
    associationNote: "Continuation success is correlated with a later workflow event; it is not attributed to the capability."
  };
}

function historicalEvidence(capability: ToolCapability, context: FailureContext, events: OutcomeEvent[]): { matchingCases: number; followedBySuccess: number } {
  const failures = events
    .filter(event => event.kind === "workflow_run" && event.outcome !== "success" && event.failureClass === context.failureClass)
    .filter(event => !context.workflow || event.name === context.workflow)
    .filter(event => !context.jobId || event.jobId === context.jobId)
    .slice(-MAX_ANALYTICS_EVENTS);
  let matchingCases = 0;
  let followedBySuccess = 0;
  for (const failure of failures) {
    const open = events
      .filter(event => event.kind === "capability_open" && event.name === capability && event.timestamp > failure.timestamp)
      .filter(event => Date.parse(event.timestamp) - Date.parse(failure.timestamp) <= MAX_ASSOCIATION_MS)
      .filter(event => {
        const openedFrom = metadataRecord(event, "openedFrom");
        return (!context.workflow || openedFrom.workflow === context.workflow || event.escalationFrom === context.workflow)
          && (!context.jobId || openedFrom.jobId === context.jobId || event.jobId === context.jobId);
      })
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0];
    if (!open) continue;
    matchingCases += 1;
    const success = events.some(event => event.kind === "workflow_run"
      && event.outcome === "success"
      && event.timestamp > open.timestamp
      && Date.parse(event.timestamp) - Date.parse(open.timestamp) <= MAX_ASSOCIATION_MS
      && (!context.workflow || event.name === context.workflow)
      && (!context.jobId || event.jobId === context.jobId));
    if (success) followedBySuccess += 1;
  }
  return { matchingCases, followedBySuccess };
}

function outcomeSummary(events: OutcomeEvent[]): Record<string, unknown> {
  const counts: Record<OutcomeStatus, number> = {
    success: 0,
    failure: 0,
    timeout: 0,
    cancelled: 0,
    blocked: 0,
    unknown: 0
  };
  for (const event of events) counts[event.outcome] += 1;
  return {
    invocations: events.length,
    runs: events.length,
    success: counts.success,
    failure: counts.failure,
    timeout: counts.timeout,
    cancelled: counts.cancelled,
    blocked: counts.blocked,
    counts,
    successRate: events.length === 0 ? null : counts.success / events.length
  };
}

function topLabels(values: readonly (string | undefined)[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 10);
}

function dimensionSummary(
  events: OutcomeEvent[],
  key: (event: OutcomeEvent) => string | undefined,
  labels: (key: string) => string[] = key => [key]
): Array<Record<string, unknown>> {
  const grouped = new Map<string, OutcomeEvent[]>();
  for (const event of events) {
    const value = key(event);
    if (!value) continue;
    for (const label of labels(value)) {
      if (!label) continue;
      const rows = grouped.get(label) ?? [];
      rows.push(event);
      grouped.set(label, rows);
    }
  }
  return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([label, rows]) => ({
    label,
    ...outcomeSummary(rows),
    duration: deterministicStatistics(rows.map(row => row.durationMs)),
    lastUsed: rows.at(-1)?.timestamp
  }));
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const name = key(value);
    const rows = grouped.get(name) ?? [];
    rows.push(value);
    grouped.set(name, rows);
  }
  return grouped;
}

function metadataString(event: OutcomeEvent | undefined, key: string): string | undefined {
  const value = event?.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metadataStringArray(event: OutcomeEvent, key: string): string[] {
  const value = event.metadata?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function metadataRecord(event: OutcomeEvent, key: string): Record<string, unknown> {
  const value = event.metadata?.[key];
  return asRecord(value);
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const output: Record<string, unknown> = {};
  const stringKeys = ["role", "family", "exposure", "capability", "approvalClass", "domainVerdict", "recommendationId", "actor"];
  for (const key of stringKeys) {
    const safe = boundedLabel(source[key]);
    if (safe) output[key] = safe;
  }
  const effects = Array.isArray(source.effects) ? source.effects.map(boundedLabel).filter((item): item is string => Boolean(item)).slice(0, 32) : [];
  if (effects.length) output.effects = effects;
  const sessionOutcome = source.sessionOutcome;
  if (sessionOutcome === "resolved" || sessionOutcome === "not-resolved" || sessionOutcome === "abandoned" || sessionOutcome === "unknown") output.sessionOutcome = sessionOutcome;
  const sourceName = source.recommendationSource;
  if (sourceName === "static-rule" || sourceName === "historical-pattern" || sourceName === "static-and-history") output.recommendationSource = sourceName;
  if (typeof source.recommendationConfidence === "number" && Number.isFinite(source.recommendationConfidence)) output.recommendationConfidence = Math.max(0, Math.min(1, source.recommendationConfidence));
  for (const key of ["matchingCases", "followedBySuccess"]) {
    const number = boundedNonNegativeInteger(source[key]);
    if (number !== undefined) output[key] = number;
  }
  if (typeof source.insufficientHistoricalSupport === "boolean") output.insufficientHistoricalSupport = source.insufficientHistoricalSupport;
  const openedFrom = asRecord(source.openedFrom);
  if (Object.keys(openedFrom).length) {
    const safeOpenedFrom: Record<string, string> = {};
    for (const key of ["workflow", "failureClass", "jobId"]) {
      const safe = key === "failureClass" ? normalizeFailureClass(openedFrom[key]) : boundedLabel(openedFrom[key]);
      if (safe) safeOpenedFrom[key] = safe;
    }
    if (Object.keys(safeOpenedFrom).length) output.openedFrom = safeOpenedFrom;
  }
  // outcomeEventMetadataSchema is intentionally used as a final shape check;
  // unknown keys are not copied into analytics storage.
  return outcomeEventMetadataSchema.parse(output);
}

function normalizeFailureClass(value: unknown): OutcomeFailureClass | undefined {
  return typeof value === "string" && OUTCOME_FAILURE_CLASSES.includes(value as OutcomeFailureClass)
    ? value as OutcomeFailureClass
    : undefined;
}

function isToolCapability(value: unknown): value is ToolCapability {
  return typeof value === "string" && ["debug.manual", "debug.program", "debug.wait", "observability.variables", "observability.dlog", "observability.erad", "observability.metrics", "can.advanced"].includes(value);
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : undefined;
}

function boundedDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 86_400_000) : 0;
}

function boundedNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, 10_000) : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? Math.min(value.length, 10_000) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

import { randomUUID } from "node:crypto";
import type { Logger } from "../utils/logger.js";
import { DebugMcpError } from "../utils/errors.js";

export const TOOL_CAPABILITY_NAMES = [
  "debug.manual",
  "debug.program",
  "debug.wait",
  "observability.variables",
  "observability.dlog",
  "observability.erad",
  "observability.metrics",
  "can.advanced"
] as const;

export type ToolCapability = typeof TOOL_CAPABILITY_NAMES[number];
export type CapabilityRisk = "read-only" | "target-control" | "program-load" | "target-mutation" | "workflow-confirmation";

export interface CapabilityDescriptor {
  name: ToolCapability;
  description: string;
  risk: CapabilityRisk;
}

export const CAPABILITY_DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    name: "debug.manual",
    description: "Manual per-core connect/run/halt/reset operations for deep interactive debugging. Prefer task-level workflows for normal IPC bring-up.",
    risk: "target-control"
  },
  {
    name: "debug.program",
    description: "Manual program/symbol loading operations. Use only when workflow-level reload behavior is insufficient.",
    risk: "program-load"
  },
  {
    name: "debug.wait",
    description: "Generic expression and IPC wait primitives for debugging outside a task-level workflow.",
    risk: "read-only"
  },
  {
    name: "observability.variables",
    description: "Bounded low-rate host-polled variable streaming. This is not a high-rate waveform acquisition tool.",
    risk: "read-only"
  },
  {
    name: "observability.dlog",
    description: "Read and export existing target-side DLOG captures. It does not arm firmware.",
    risk: "read-only"
  },
  {
    name: "observability.erad",
    description: "Configure and run F28P65x ERAD profiling using fenced hardware resources. It may modify ERAD registers.",
    risk: "target-mutation"
  },
  {
    name: "observability.metrics",
    description: "Create and compare deterministic run metrics, baselines, and acceptance evidence for regression analysis.",
    risk: "workflow-confirmation"
  },
  {
    name: "can.advanced",
    description: "Specialized multi-board CAN campaigns, soak execution, profiles, and board-group diagnostics.",
    risk: "target-control"
  }
];

export type CapabilitySessionEndReason = "closed" | "expired";
export type CapabilitySessionOutcome = "resolved" | "not-resolved" | "abandoned" | "unknown";

export interface CapabilitySessionContext {
  workflow?: string;
  failureClass?: string;
  jobId?: string;
}

export interface CapabilitySession {
  id: string;
  capability: ToolCapability;
  createdAt: string;
  expiresAt: string;
  reason: string;
  requestedBy: string;
  active: boolean;
  openedFrom?: CapabilitySessionContext;
  recommendationId?: string;
  endedAt?: string;
  outcome?: CapabilitySessionOutcome;
}

export interface CapabilityAuditEvent {
  event: "c2000_capability_session";
  action: "open" | "close" | "expire";
  capability: ToolCapability;
  sessionId: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  actor: string;
  timestamp: string;
  openedFrom?: CapabilitySessionContext;
  recommendationId?: string;
  outcome?: CapabilitySessionOutcome;
}

export interface CapabilitySessionManagerOptions {
  now?: () => number;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  requestedBy?: string;
  logger?: Pick<Logger, "info" | "warn">;
  onAudit?: (event: CapabilityAuditEvent) => void;
}

export interface OpenCapabilitySessionResult {
  session: CapabilitySession;
  created: boolean;
}

export const DEFAULT_CAPABILITY_TTL_SECONDS = 15 * 60;
export const MAX_CAPABILITY_TTL_SECONDS = 30 * 60;

/**
 * Process-local, expiring capability state. It knows nothing about target
 * safety; ToolDefinition effects remain the policy source for that decision.
 */
export class CapabilitySessionManager {
  private readonly sessions = new Map<string, CapabilitySession>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly endedReasons = new Map<ToolCapability, CapabilitySessionEndReason>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly requestedBy: string;
  private readonly logger?: Pick<Logger, "info" | "warn">;
  private readonly onAudit?: (event: CapabilityAuditEvent) => void;

  constructor(options: CapabilitySessionManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
    this.maxTtlSeconds = options.maxTtlSeconds ?? MAX_CAPABILITY_TTL_SECONDS;
    this.requestedBy = options.requestedBy ?? "mcp-client";
    this.logger = options.logger;
    this.onAudit = options.onAudit;
    this.validateTtl(this.defaultTtlSeconds);
    this.validateTtl(this.maxTtlSeconds);
    if (this.defaultTtlSeconds > this.maxTtlSeconds) {
      throw new Error("Capability session default TTL cannot exceed the maximum TTL");
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(
    capability: string,
    reason: string,
    ttlSeconds?: number,
    requestedBy = this.requestedBy,
    context?: CapabilitySessionContext,
    recommendationId?: string
  ): OpenCapabilitySessionResult {
    this.purgeExpired();
    const normalizedCapability = normalizeCapability(capability);
    const descriptor = CAPABILITY_DESCRIPTORS.find(candidate => candidate.name === normalizedCapability);
    if (!descriptor) {
      throw new DebugMcpError("CapabilityUnknown", `Unknown C2000 capability: ${capability}`, {
        capability,
        availableCapabilities: TOOL_CAPABILITY_NAMES
      });
    }
    const knownCapability = descriptor.name;
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new DebugMcpError("CapabilityReasonRequired", "Capability exposure requires a non-empty reason", {
        capability: knownCapability
      });
    }
    const effectiveTtlSeconds = ttlSeconds ?? this.defaultTtlSeconds;
    this.validateTtl(effectiveTtlSeconds, knownCapability);

    const existing = this.findActive(knownCapability);
    if (existing) {
      return { session: { ...existing }, created: false };
    }

    const createdAtMs = this.now();
    const session: CapabilitySession = {
      id: randomUUID(),
      capability: knownCapability,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + effectiveTtlSeconds * 1000).toISOString(),
      reason: normalizedReason,
      requestedBy: requestedBy.trim() || this.requestedBy,
      active: true,
      ...(context ? { openedFrom: { ...context } } : {}),
      ...(recommendationId?.trim() ? { recommendationId: recommendationId.trim() } : {})
    };
    this.sessions.set(session.id, session);
    this.endedReasons.delete(knownCapability);
    this.scheduleExpiry(session);
    this.audit("open", session);
    this.notifyChanged();
    return { session: { ...session }, created: true };
  }

  close(sessionId: string, outcome: CapabilitySessionOutcome = "unknown"): CapabilitySession {
    this.purgeExpired();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new DebugMcpError("CapabilitySessionNotFound", `Capability session not found: ${sessionId}`, {
        sessionId
      });
    }
    this.sessions.delete(sessionId);
    this.clearTimer(sessionId);
    this.endedReasons.set(session.capability, "closed");
    const closed = { ...session, active: false, endedAt: new Date(this.now()).toISOString(), outcome };
    this.audit("close", closed);
    this.notifyChanged();
    return closed;
  }

  purgeExpired(): CapabilitySession[] {
    const nowMs = this.now();
    const expired: CapabilitySession[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (Date.parse(session.expiresAt) > nowMs) continue;
      this.sessions.delete(sessionId);
      this.clearTimer(sessionId);
      this.endedReasons.set(session.capability, "expired");
      const expiredSession = { ...session, active: false, endedAt: new Date(nowMs).toISOString(), outcome: "abandoned" as const };
      expired.push(expiredSession);
      this.audit("expire", expiredSession);
    }
    if (expired.length > 0) this.notifyChanged();
    return expired;
  }

  listActiveSessions(): CapabilitySession[] {
    this.purgeExpired();
    return Array.from(this.sessions.values(), session => ({ ...session }));
  }

  activeCapabilities(): ToolCapability[] {
    this.purgeExpired();
    return Array.from(new Set(Array.from(this.sessions.values(), session => session.capability)));
  }

  hasActive(capability: ToolCapability): boolean {
    this.purgeExpired();
    return this.findActive(capability) !== undefined;
  }

  lastEndedReason(capability: ToolCapability): CapabilitySessionEndReason | undefined {
    this.purgeExpired();
    return this.endedReasons.get(capability);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private findActive(capability: ToolCapability): CapabilitySession | undefined {
    return Array.from(this.sessions.values()).find(session => session.capability === capability);
  }

  private validateTtl(ttlSeconds: number, capability?: ToolCapability): void {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > this.maxTtlSeconds) {
      throw new DebugMcpError("CapabilityInvalidTtl", `Capability session TTL must be an integer between 1 and ${this.maxTtlSeconds} seconds`, {
        capability,
        ttlSeconds,
        defaultTtlSeconds: this.defaultTtlSeconds,
        maxTtlSeconds: this.maxTtlSeconds
      });
    }
  }

  private scheduleExpiry(session: CapabilitySession): void {
    const delayMs = Math.max(1, Date.parse(session.expiresAt) - this.now() + 1);
    const timer = setTimeout(() => {
      this.purgeExpired();
    }, delayMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.timers.set(session.id, timer);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private audit(action: CapabilityAuditEvent["action"], session: CapabilitySession): void {
    const event: CapabilityAuditEvent = {
      event: "c2000_capability_session",
      action,
      capability: session.capability,
      sessionId: session.id,
      reason: session.reason,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      actor: session.requestedBy,
      timestamp: session.endedAt ?? session.createdAt,
      ...(session.openedFrom ? { openedFrom: { ...session.openedFrom } } : {}),
      ...(session.recommendationId ? { recommendationId: session.recommendationId } : {}),
      ...(session.outcome ? { outcome: session.outcome } : {})
    };
    this.logger?.info("c2000_capability_session", event);
    try {
      this.onAudit?.(event);
    } catch (error) {
      this.logger?.warn("c2000 capability analytics audit failed", { error });
    }
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalizeCapability(value: string): string {
  return value.trim();
}

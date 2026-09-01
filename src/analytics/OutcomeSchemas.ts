import { z } from "zod";
import { TOOL_CAPABILITY_NAMES } from "../mcp/capabilities.js";

export const OUTCOME_EVENT_KINDS = [
  "tool_invocation",
  "workflow_run",
  "capability_open",
  "capability_close",
  "capability_expire",
  "escalation_recommendation"
] as const;

export const OUTCOME_STATUSES = ["success", "failure", "timeout", "cancelled", "blocked", "unknown"] as const;

export const OUTCOME_FAILURE_CLASSES = [
  "environment",
  "probe",
  "connection",
  "program-load",
  "flash-protection",
  "boot-handoff",
  "ipc-timeout",
  "core-state",
  "expression",
  "ram-ownership",
  "board-lease",
  "worker",
  "can",
  "dlog",
  "erad",
  "capability",
  "filesystem",
  "unknown"
] as const;

export const ANALYTICS_WINDOWS = ["24h", "7d", "30d", "retained"] as const;

export const outcomeEventSchema = z.object({
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  kind: z.enum(OUTCOME_EVENT_KINDS),
  name: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  outcome: z.enum(OUTCOME_STATUSES),
  durationMs: z.number().finite().nonnegative().optional(),
  stage: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/).optional(),
  errorCode: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  failureClass: z.enum(OUTCOME_FAILURE_CLASSES).optional(),
  toolProfile: z.enum(["readonly", "safe", "full"]),
  toolSurfaceProfile: z.enum(["agent", "advanced", "compatibility"]),
  activeCapabilities: z.array(z.enum(TOOL_CAPABILITY_NAMES)),
  boardCount: z.number().int().nonnegative().optional(),
  coreCount: z.number().int().nonnegative().optional(),
  jobId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  escalationFrom: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  escalationTo: z.enum(TOOL_CAPABILITY_NAMES).optional(),
  metadata: z.record(z.unknown()).default({})
});

export type OutcomeEventKind = typeof OUTCOME_EVENT_KINDS[number];
export type OutcomeStatus = typeof OUTCOME_STATUSES[number];
export type OutcomeFailureClass = typeof OUTCOME_FAILURE_CLASSES[number];
export type AnalyticsWindow = typeof ANALYTICS_WINDOWS[number];
export type OutcomeEvent = z.infer<typeof outcomeEventSchema>;

export const outcomeEventMetadataSchema = z.object({
  role: z.string().optional(),
  family: z.string().optional(),
  exposure: z.string().optional(),
  capability: z.enum(TOOL_CAPABILITY_NAMES).optional(),
  approvalClass: z.string().optional(),
  effects: z.array(z.string()).optional(),
  domainVerdict: z.string().optional(),
  sessionOutcome: z.enum(["resolved", "not-resolved", "abandoned", "unknown"]).optional(),
  recommendationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  recommendationSource: z.enum(["static-rule", "historical-pattern", "static-and-history"]).optional(),
  recommendationConfidence: z.number().finite().min(0).max(1).optional(),
  matchingCases: z.number().int().nonnegative().optional(),
  followedBySuccess: z.number().int().nonnegative().optional(),
  insufficientHistoricalSupport: z.boolean().optional(),
  openedFrom: z.object({
    workflow: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
    failureClass: z.enum(OUTCOME_FAILURE_CLASSES).optional(),
    jobId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
  }).optional(),
  actor: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional()
}).passthrough();

export type OutcomeEventMetadata = z.infer<typeof outcomeEventMetadataSchema>;

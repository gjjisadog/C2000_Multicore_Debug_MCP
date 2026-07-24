import type { C2000ToolInvoker } from "../mcp/tools.js";
import { DebugMcpError } from "../utils/errors.js";
import type { BoardGroupRecord } from "../storage/repositories/BoardGroupRepository.js";
import type { CanAcceptanceProfile, CanEndpoint, CrossBoardComparison } from "./CanProfileSchema.js";

export interface GroupEndpoint {
  groupId: string;
  boardId: string;
  workerInstanceId?: string;
  sessionId: string;
  coreId: number;
  expression: string;
}

/** Internal service only. It intentionally does not create a public MCP atomic cross-board API. */
export class CrossBoardExpressionService {
  constructor(private readonly tools: C2000ToolInvoker) {}

  async evaluateSafety(group: BoardGroupRecord, profile: CanAcceptanceProfile): Promise<Record<string, unknown>> {
    if (profile.safety.gates.length === 0) {
      return { status: "UNSUPPORTED", reason: "Profile does not declare read-only safety gates", gates: [] };
    }
    const gates = await Promise.all(profile.safety.gates.map(async gate => {
      const endpoint = this.resolveEndpoint(group, profile, gate.endpoint);
      const sample = await this.sample(endpoint);
      const matched = valuesEqual(sample.value, gate.expected);
      return { name: gate.name, endpoint, expected: gate.expected, actual: sample.value, matched, sampledAt: sample.sampledAt, ...(gate.description ? { description: gate.description } : {}) };
    }));
    const passed = gates.every(gate => gate.matched);
    return { status: passed ? "PASSED" : "FAILED", required: profile.safety.required, gates };
  }

  async compare(group: BoardGroupRecord, profile: CanAcceptanceProfile): Promise<Record<string, unknown>[]> {
    return Promise.all(profile.comparisons.map(comparison => this.compareOne(group, profile, comparison)));
  }

  private async compareOne(group: BoardGroupRecord, profile: CanAcceptanceProfile, comparison: CrossBoardComparison): Promise<Record<string, unknown>> {
    const left = this.resolveEndpoint(group, profile, comparison.left);
    const right = comparison.right ? this.resolveEndpoint(group, profile, comparison.right) : undefined;
    const samples: Array<Record<string, unknown>> = [];
    for (let index = 0; index < comparison.sampleCount; index += 1) {
      const startedAt = Date.now();
      const [leftSample, rightSample] = await Promise.all([this.sample(left), right ? this.sample(right) : Promise.resolve(undefined)]);
      const finishedAt = Date.now();
      samples.push({ index, left: leftSample, ...(rightSample ? { right: rightSample } : {}), samplingSkewMs: rightSample ? Math.abs(Date.parse(leftSample.sampledAt) - Date.parse(rightSample.sampledAt)) : 0, elapsedMs: finishedAt - startedAt });
      if (index + 1 < comparison.sampleCount && comparison.intervalMs > 0) await sleep(comparison.intervalMs);
    }
    const matched = evaluate(comparison, samples);
    return { name: comparison.name, operator: comparison.operator, matched, left, ...(right ? { right } : {}), tolerance: comparison.tolerance, expected: comparison.expected, samples };
  }

  private resolveEndpoint(group: BoardGroupRecord, profile: CanAcceptanceProfile, endpoint: CanEndpoint): GroupEndpoint {
    const boardId = endpoint.boardId ?? profile.roles.find(role => role.role === endpoint.role)?.boardId ?? group.members.find(member => member.role === endpoint.role)?.boardId;
    if (!boardId) throw new DebugMcpError("CanProfileInvalid", "Profile endpoint cannot resolve a board from its role", { groupId: group.groupId, endpoint, roles: profile.roles, members: group.members.map(member => ({ boardId: member.boardId, role: member.role })) });
    const member = group.members.find(item => item.boardId === boardId);
    if (!member?.sessionId) throw new DebugMcpError("CanDebugObservationFailed", "Cross-board endpoint has no worker-routed debug session", { groupId: group.groupId, boardId, endpoint });
    return { groupId: group.groupId, boardId, ...(member.workerInstanceId ? { workerInstanceId: member.workerInstanceId } : {}), sessionId: member.sessionId, coreId: endpoint.coreId, expression: endpoint.expression };
  }

  private async sample(endpoint: GroupEndpoint): Promise<{ value: unknown; sampledAt: string }> {
    const result = await this.tools.invokeTool("c2000_evaluateMany", { sessionId: endpoint.sessionId, coreId: endpoint.coreId, expressions: [endpoint.expression] });
    if (result.success !== true) throw new DebugMcpError("CanDebugObservationFailed", "Cross-board expression evaluation failed", { endpoint, result });
    const values = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : [];
    const item = values.find(value => value.expression === endpoint.expression);
    if (!item || item.success === false) throw new DebugMcpError("CanDebugObservationFailed", "Cross-board expression result is missing", { endpoint, result });
    return { value: item.value, sampledAt: new Date().toISOString() };
  }
}

function evaluate(comparison: CrossBoardComparison, samples: Array<Record<string, unknown>>): boolean {
  const latest = samples.at(-1) ?? {};
  const left = (latest.left as { value?: unknown } | undefined)?.value;
  const right = (latest.right as { value?: unknown } | undefined)?.value;
  switch (comparison.operator) {
    case "EQUAL": return valuesEqual(left, right);
    case "NOT_EQUAL": return !valuesEqual(left, right);
    case "GREATER_THAN": return numeric(left) > numeric(right);
    case "GREATER_THAN_OR_EQUAL": return numeric(left) >= numeric(right);
    case "LESS_THAN": return numeric(left) < numeric(right);
    case "LESS_THAN_OR_EQUAL": return numeric(left) <= numeric(right);
    case "WITHIN": return Math.abs(numeric(left) - numeric(right)) <= (comparison.tolerance ?? 0);
    case "DELTA": return Math.abs(numeric(left) - numeric(right)) <= (comparison.tolerance ?? 0);
    case "BOOLEAN": return valuesEqual(left, comparison.expected);
    case "MONOTONIC": {
      const values = samples.map(sample => numeric((sample.left as { value?: unknown } | undefined)?.value));
      return values.every((value, index) => index === 0 || value >= values[index - 1]!);
    }
  }
}

function numeric(value: unknown): number { return typeof value === "number" ? value : Number(value); }
function valuesEqual(left: unknown, right: unknown): boolean { return left === right; }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

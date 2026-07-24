import { randomUUID } from "node:crypto";
import { SqliteStore } from "../SqliteStore.js";

export interface BoardGroupReconcileDecision {
  decisionId?: string;
  groupId: string;
  jobId: string;
  decision: string;
  reason: string;
  evidence: Record<string, unknown>;
  createdAt?: string;
}

export class BoardGroupReconcileDecisionRepository {
  constructor(private readonly store: SqliteStore) {}

  add(input: BoardGroupReconcileDecision): string {
    const decisionId = input.decisionId ?? `group-reconcile-${randomUUID()}`;
    this.store.run("INSERT INTO board_group_reconcile_decisions(decision_id, group_id, job_id, decision, reason, evidence_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)", [decisionId, input.groupId, input.jobId, input.decision, input.reason, JSON.stringify(input.evidence), input.createdAt ?? new Date().toISOString()]);
    return decisionId;
  }

  list(groupId: string): Required<BoardGroupReconcileDecision>[] {
    return this.store.all<Record<string, unknown>>("SELECT * FROM board_group_reconcile_decisions WHERE group_id = ? ORDER BY created_at", [groupId]).map(row => ({ decisionId: String(row.decision_id), groupId: String(row.group_id), jobId: String(row.job_id), decision: String(row.decision), reason: String(row.reason), evidence: parseJson(String(row.evidence_json), {}), createdAt: String(row.created_at) }));
  }
}
function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }

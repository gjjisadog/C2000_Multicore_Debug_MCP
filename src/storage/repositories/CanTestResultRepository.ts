import { randomUUID } from "node:crypto";
import { SqliteStore } from "../SqliteStore.js";

export interface CanTestResult {
  resultId?: string;
  jobId: string;
  groupId: string;
  phase: string;
  status: "PASSED" | "FAILED" | "SKIPPED" | "INFO";
  details: Record<string, unknown>;
  createdAt?: string;
}

export class CanTestResultRepository {
  constructor(private readonly store: SqliteStore) {}

  add(result: CanTestResult): string {
    const resultId = result.resultId ?? `can-${randomUUID()}`;
    this.store.run(
      "INSERT INTO can_test_results(result_id, job_id, group_id, phase, status, details_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [resultId, result.jobId, result.groupId, result.phase, result.status, JSON.stringify(result.details), result.createdAt ?? new Date().toISOString()]
    );
    return resultId;
  }

  list(jobId: string): Array<Required<CanTestResult>> {
    return this.store.all<Record<string, unknown>>(
      "SELECT * FROM can_test_results WHERE job_id = ? ORDER BY created_at, result_id", [jobId]
    ).map(row => ({
      resultId: String(row.result_id), jobId: String(row.job_id), groupId: String(row.group_id), phase: String(row.phase),
      status: String(row.status) as CanTestResult["status"], details: parseJson(String(row.details_json), {}), createdAt: String(row.created_at)
    }));
  }

  listByGroup(groupId: string): Array<Required<CanTestResult>> {
    return this.store.all<Record<string, unknown>>(
      "SELECT * FROM can_test_results WHERE group_id = ? ORDER BY created_at, result_id", [groupId]
    ).map(row => ({
      resultId: String(row.result_id), jobId: String(row.job_id), groupId: String(row.group_id), phase: String(row.phase),
      status: String(row.status) as CanTestResult["status"], details: parseJson(String(row.details_json), {}), createdAt: String(row.created_at)
    }));
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

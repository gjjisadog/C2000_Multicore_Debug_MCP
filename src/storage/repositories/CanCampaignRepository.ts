import { createHash, randomUUID } from "node:crypto";
import { SqliteStore } from "../SqliteStore.js";

export type CanCampaignType = "FAULT_CAMPAIGN" | "MATRIX" | "SOAK";
export type CanCampaignStatus = "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "PARTIAL" | "CANCELLED" | "RECOVERING" | "NEEDS_MANUAL_INTERVENTION";

export interface CanCampaignRecord {
  campaignId: string;
  jobId: string;
  groupId?: string;
  type: CanCampaignType;
  status: CanCampaignStatus;
  definition: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  summary?: Record<string, unknown>;
  error?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CanMatrixCaseRecord {
  caseId: string;
  campaignId: string;
  caseIndex: number;
  caseHash: string;
  status: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "SKIPPED" | "UNSUPPORTED";
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  error?: Record<string, unknown>;
}

export class CanCampaignRepository {
  constructor(private readonly store: SqliteStore) {}

  create(input: { campaignId: string; jobId: string; groupId?: string; type: CanCampaignType; definition: Record<string, unknown>; cases: Record<string, unknown>[] }): CanCampaignRecord {
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run("INSERT INTO can_campaigns(campaign_id, job_id, group_id, campaign_type, status, definition_json, checkpoint_json, summary_json, error_json, created_at, updated_at) VALUES(?, ?, ?, ?, 'QUEUED', ?, '{}', NULL, NULL, ?, ?)", [input.campaignId, input.jobId, input.groupId ?? null, input.type, JSON.stringify(input.definition), now, now]);
      input.cases.forEach((caseInput, caseIndex) => {
        const caseHash = stableHash(caseInput);
        this.store.run("INSERT INTO can_matrix_cases(case_id, campaign_id, case_index, case_hash, status, input_json, result_json, started_at, finished_at, error_json) VALUES(?, ?, ?, ?, 'PENDING', ?, NULL, NULL, NULL, NULL)", [`case-${randomUUID()}`, input.campaignId, caseIndex, caseHash, JSON.stringify(caseInput)]);
      });
    });
    return this.require(input.campaignId);
  }

  require(campaignId: string): CanCampaignRecord {
    const row = this.store.get<Record<string, unknown>>("SELECT * FROM can_campaigns WHERE campaign_id = ?", [campaignId]);
    if (!row) throw new Error(`CAN campaign not found: ${campaignId}`);
    return mapCampaign(row);
  }

  getByJob(jobId: string): CanCampaignRecord | undefined {
    const row = this.store.get<{ campaign_id: string }>("SELECT campaign_id FROM can_campaigns WHERE job_id = ? ORDER BY created_at DESC LIMIT 1", [jobId]);
    return row ? this.require(row.campaign_id) : undefined;
  }

  update(campaignId: string, status: CanCampaignStatus, patch: Partial<Pick<CanCampaignRecord, "checkpoint" | "summary" | "error">> = {}): CanCampaignRecord {
    const current = this.require(campaignId);
    this.store.run("UPDATE can_campaigns SET status = ?, checkpoint_json = ?, summary_json = ?, error_json = ?, updated_at = ? WHERE campaign_id = ?", [status, JSON.stringify(patch.checkpoint ?? current.checkpoint), patch.summary ? JSON.stringify(patch.summary) : current.summary ? JSON.stringify(current.summary) : null, patch.error ? JSON.stringify(patch.error) : current.error ? JSON.stringify(current.error) : null, new Date().toISOString(), campaignId]);
    return this.require(campaignId);
  }

  cases(campaignId: string): CanMatrixCaseRecord[] {
    return this.store.all<Record<string, unknown>>("SELECT * FROM can_matrix_cases WHERE campaign_id = ? ORDER BY case_index", [campaignId]).map(mapCase);
  }

  updateCase(caseId: string, status: CanMatrixCaseRecord["status"], patch: Partial<Pick<CanMatrixCaseRecord, "result" | "error">> = {}): CanMatrixCaseRecord {
    const current = this.store.get<Record<string, unknown>>("SELECT * FROM can_matrix_cases WHERE case_id = ?", [caseId]);
    if (!current) throw new Error(`CAN matrix case not found: ${caseId}`);
    const now = new Date().toISOString();
    this.store.run("UPDATE can_matrix_cases SET status = ?, result_json = ?, error_json = ?, started_at = ?, finished_at = ? WHERE case_id = ?", [status, patch.result ? JSON.stringify(patch.result) : current.result_json ?? null, patch.error ? JSON.stringify(patch.error) : current.error_json ?? null, status === "RUNNING" ? now : current.started_at ?? null, ["PASSED", "FAILED", "SKIPPED", "UNSUPPORTED"].includes(status) ? now : current.finished_at ?? null, caseId]);
    return mapCase(this.store.get<Record<string, unknown>>("SELECT * FROM can_matrix_cases WHERE case_id = ?", [caseId])!);
  }

  checkpointSoak(campaignId: string, iteration: number, elapsedMs: number, status: string, summary: Record<string, unknown>): void {
    this.store.run("INSERT OR REPLACE INTO can_soak_checkpoints(checkpoint_id, campaign_id, iteration, elapsed_ms, status, summary_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)", [`soak-${campaignId}-${iteration}`, campaignId, iteration, elapsedMs, status, JSON.stringify(summary), new Date().toISOString()]);
  }
}

function mapCampaign(row: Record<string, unknown>): CanCampaignRecord {
  return { campaignId: String(row.campaign_id), jobId: String(row.job_id), ...(row.group_id ? { groupId: String(row.group_id) } : {}), type: String(row.campaign_type) as CanCampaignType, status: String(row.status) as CanCampaignStatus, definition: parseJson(String(row.definition_json), {}), checkpoint: parseJson(String(row.checkpoint_json), {}), ...(row.summary_json ? { summary: parseJson(String(row.summary_json), {}) } : {}), ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function mapCase(row: Record<string, unknown>): CanMatrixCaseRecord { return { caseId: String(row.case_id), campaignId: String(row.campaign_id), caseIndex: Number(row.case_index), caseHash: String(row.case_hash), status: String(row.status) as CanMatrixCaseRecord["status"], input: parseJson(String(row.input_json), {}), ...(row.result_json ? { result: parseJson(String(row.result_json), {}) } : {}), ...(row.error_json ? { error: parseJson(String(row.error_json), {}) } : {}), ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}) }; }
function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
function stableHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex"); }
function sortValue(value: unknown): unknown { return Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)])) : value; }

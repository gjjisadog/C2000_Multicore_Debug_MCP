import { DebugMcpError } from "../../utils/errors.js";
import type { Logger } from "../../utils/logger.js";
import type { MergeabilityState, ReviewCheckStatus, ReviewState } from "./ReviewSchemas.js";
import type { ReviewFeedbackDisposition, ReviewFeedbackSource } from "../revision/RevisionSchemas.js";

export interface ProviderPullRequest {
  number: number;
  url: string;
  repository: string;
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedSha?: string;
  mergedAt?: string;
  updatedAt: string;
  mergeable: MergeabilityState;
}

export interface ProviderCheck {
  name: string;
  status: ReviewCheckStatus;
  conclusion?: string;
  candidateSha: string;
  details?: string;
}

export interface ProviderReview {
  id: number;
  login: string;
  userType: "User" | "Bot" | "Organization" | "Unknown";
  state: ReviewState;
  submittedAt?: string;
}

/** Raw provider evidence. `body` is consumed by the sanitizer and is never an instruction. */
export interface ProviderReviewFeedback {
  pullRequestId: string;
  pullRequestNumber: number;
  reviewId?: number;
  threadId?: string;
  commentId?: number;
  author: string;
  authorType: "human" | "bot" | "unknown";
  createdAt: string;
  updatedAt?: string;
  source: ReviewFeedbackSource;
  disposition: ReviewFeedbackDisposition;
  body: string;
  path?: string;
  line?: number;
  candidateSha?: string;
  resolved?: boolean;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  draft: boolean;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
  draft?: boolean;
  state?: "open" | "closed";
}

export interface ImprovementCodeReviewProvider {
  createPullRequest(input: CreatePullRequestInput): Promise<ProviderPullRequest>;
  getPullRequest(number: number): Promise<ProviderPullRequest>;
  findOpenPullRequest(branch: string, baseBranch: string): Promise<ProviderPullRequest | undefined>;
  updatePullRequest(number: number, input: UpdatePullRequestInput): Promise<ProviderPullRequest>;
  listChecks(candidateSha: string): Promise<ProviderCheck[]>;
  listReviews(number: number): Promise<ProviderReview[]>;
  /** Optional for backwards-compatible injected providers; GitHub REST implements it. */
  listReviewFeedback?(number: number): Promise<ProviderReviewFeedback[]>;
}

export interface GitHubReviewProviderOptions {
  repository: string;
  apiBaseUrl: string;
  githubTokenEnv: string;
  token?: string;
  fetch?: typeof fetch;
  logger?: Pick<Logger, "warn">;
}

/**
 * Small REST adapter for PR/check/review evidence. It intentionally exposes
 * no merge or approval API. Credentials are read by the server process only;
 * they are never included in a coding-agent environment or an error detail.
 */
export class GitHubReviewProvider implements ImprovementCodeReviewProvider {
  private readonly repository: string;
  private readonly apiBaseUrl: string;
  private readonly tokenEnv: string;
  private readonly injectedToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Pick<Logger, "warn">;

  constructor(options: GitHubReviewProviderOptions) {
    this.repository = options.repository;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.tokenEnv = options.githubTokenEnv;
    this.injectedToken = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<ProviderPullRequest> {
    const value = await this.request("POST", `/repos/${this.repository}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: input.baseBranch,
      draft: input.draft
    });
    return parsePullRequest(value, this.repository);
  }

  async getPullRequest(number: number): Promise<ProviderPullRequest> {
    const value = await this.request("GET", `/repos/${this.repository}/pulls/${number}`);
    return parsePullRequest(value, this.repository);
  }

  async findOpenPullRequest(branch: string, baseBranch: string): Promise<ProviderPullRequest | undefined> {
    const value = await this.request("GET", `/repos/${this.repository}/pulls?state=open&head=${encodeURIComponent(`${this.repository.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=100`);
    if (!Array.isArray(value)) return undefined;
    const matches = value.map(item => parsePullRequest(item, this.repository)).filter(item => item.state === "open" && item.branch === branch && item.baseBranch === baseBranch);
    return matches[0];
  }

  async updatePullRequest(number: number, input: UpdatePullRequestInput): Promise<ProviderPullRequest> {
    const value = await this.request("PATCH", `/repos/${this.repository}/pulls/${number}`, input);
    return parsePullRequest(value, this.repository);
  }

  async listChecks(candidateSha: string): Promise<ProviderCheck[]> {
    const value = await this.request("GET", `/repos/${this.repository}/commits/${candidateSha}/check-runs?per_page=100`);
    const runs = value && typeof value === "object" && Array.isArray((value as { check_runs?: unknown }).check_runs)
      ? (value as { check_runs: unknown[] }).check_runs
      : [];
    return runs.flatMap(run => parseCheck(run, candidateSha));
  }

  async listReviews(number: number): Promise<ProviderReview[]> {
    const value = await this.request("GET", `/repos/${this.repository}/pulls/${number}/reviews?per_page=100`);
    if (!Array.isArray(value)) return [];
    return value.flatMap(review => parseReview(review));
  }

  async listReviewFeedback(number: number): Promise<ProviderReviewFeedback[]> {
    const [reviews, comments, issueComments] = await Promise.all([
      this.request("GET", `/repos/${this.repository}/pulls/${number}/reviews?per_page=100`),
      this.request("GET", `/repos/${this.repository}/pulls/${number}/comments?per_page=100`),
      this.request("GET", `/repos/${this.repository}/issues/${number}/comments?per_page=100`)
    ]);
    const pullRequestId = `${this.repository}#${number}`;
    return [
      ...(Array.isArray(reviews) ? reviews.flatMap(item => parseReviewFeedback(item, pullRequestId, number, "review")) : []),
      ...(Array.isArray(comments) ? comments.flatMap(item => parseReviewFeedback(item, pullRequestId, number, "review-comment")) : []),
      ...(Array.isArray(issueComments) ? issueComments.flatMap(item => parseReviewFeedback(item, pullRequestId, number, "issue-comment")) : [])
    ];
  }

  private async request(method: "GET" | "POST" | "PATCH", resource: string, body?: unknown): Promise<unknown> {
    const token = this.injectedToken ?? process.env[this.tokenEnv];
    if (!token) {
      throw new DebugMcpError("GitHubCredentialsUnavailable", "GitHub review credentials are not configured for the server", {
        credentialEnv: this.tokenEnv,
        repository: this.repository,
        actionRequired: "Configure the server-side GitHub token environment variable; it is never passed to the coding agent."
      });
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${resource}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      throw new DebugMcpError("GitHubApiUnavailable", "GitHub review API is unavailable", {
        repository: this.repository,
        method,
        resource,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (response.status === 401) throw new DebugMcpError("GitHubCredentialsUnavailable", "GitHub rejected the configured review credentials", { repository: this.repository });
    if (response.status === 404 && /\/pulls\/\d+(?:$|\/)/.test(resource)) {
      throw new DebugMcpError("PullRequestNotFound", "GitHub could not find the requested improvement pull request", { repository: this.repository, resource });
    }
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") throw new DebugMcpError("GitHubRateLimited", "GitHub review API rate limit is exhausted", { repository: this.repository });
    if (!response.ok) {
      this.logger?.warn("c2000 GitHub review API request failed", { repository: this.repository, method, resource, status: response.status });
      throw new DebugMcpError("GitHubApiUnavailable", "GitHub review API returned an unsuccessful response", { repository: this.repository, method, resource, status: response.status });
    }
    try {
      return await response.json() as unknown;
    } catch (error) {
      throw new DebugMcpError("GitHubApiUnavailable", "GitHub review API returned invalid JSON", { repository: this.repository, resource, cause: error instanceof Error ? error.message : String(error) });
    }
  }
}

function parsePullRequest(value: unknown, repository: string): ProviderPullRequest {
  if (!value || typeof value !== "object") throw new DebugMcpError("GitHubApiUnavailable", "GitHub returned an invalid pull request record", { repository });
  const record = value as Record<string, unknown>;
  const head = record.head && typeof record.head === "object" ? record.head as Record<string, unknown> : {};
  const base = record.base && typeof record.base === "object" ? record.base as Record<string, unknown> : {};
  const number = Number(record.number);
  const branch = typeof head.ref === "string" ? head.ref : "";
  const baseBranch = typeof base.ref === "string" ? base.ref : "";
  const headSha = typeof head.sha === "string" ? head.sha : "";
  const baseSha = typeof base.sha === "string" ? base.sha : "";
  const url = typeof record.html_url === "string" ? record.html_url : "";
  const updatedAt = typeof record.updated_at === "string" ? record.updated_at : new Date(0).toISOString();
  if (!Number.isInteger(number) || number <= 0 || !branch || !baseBranch || !/^[0-9a-f]{7,64}$/i.test(headSha) || !/^[0-9a-f]{7,64}$/i.test(baseSha) || !url) {
    throw new DebugMcpError("GitHubApiUnavailable", "GitHub returned an incomplete pull request record", { repository });
  }
  const mergeable = record.mergeable === true ? "mergeable" : record.mergeable === false ? "conflicting" : "unknown";
  return {
    number,
    url,
    repository,
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    branch,
    baseBranch,
    headSha,
    baseSha,
    state: record.state === "closed" ? "closed" : "open",
    draft: record.draft === true,
    merged: record.merged === true,
    ...(typeof record.merge_commit_sha === "string" && /^[0-9a-f]{7,64}$/i.test(record.merge_commit_sha) ? { mergedSha: record.merge_commit_sha } : {}),
    ...(typeof record.merged_at === "string" ? { mergedAt: record.merged_at } : {}),
    updatedAt,
    mergeable
  };
}

function parseCheck(value: unknown, candidateSha: string): ProviderCheck[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) return [];
  const status = record.status === "completed"
    ? record.conclusion === "success" ? "passed" : record.conclusion === "skipped" || record.conclusion === "neutral" ? record.conclusion : "failed"
    : "pending";
  return [{
    name: record.name,
    status: status as ReviewCheckStatus,
    candidateSha,
    ...(typeof record.conclusion === "string" ? { conclusion: record.conclusion } : {}),
    ...(typeof record.details_url === "string" ? { details: record.details_url } : {})
  }];
}

function parseReview(value: unknown): ProviderReview[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const user = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : {};
  if (!Number.isInteger(Number(record.id)) || typeof user.login !== "string") return [];
  const state = String(record.state ?? "PENDING").toUpperCase();
  const normalizedState: ReviewState = state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "changes-requested" : state === "COMMENTED" ? "commented" : state === "DISMISSED" ? "dismissed" : "pending";
  const userType = user.type === "Bot" ? "Bot" : user.type === "User" ? "User" : user.type === "Organization" ? "Organization" : "Unknown";
  return [{
    id: Number(record.id),
    login: user.login,
    userType,
    state: normalizedState,
    ...(typeof record.submitted_at === "string" ? { submittedAt: record.submitted_at } : {})
  }];
}

function parseReviewFeedback(value: unknown, pullRequestId: string, pullRequestNumber: number, source: "review" | "review-comment" | "issue-comment"): ProviderReviewFeedback[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const user = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : {};
  const id = Number(record.id);
  const body = typeof record.body === "string" ? record.body : "";
  const author = typeof user.login === "string" ? user.login : "unknown";
  if (!Number.isInteger(id) || id <= 0 || !body.trim()) return [];
  const userType = user.type === "Bot" ? "bot" : user.type === "User" ? "human" : "unknown";
  const state = String(record.state ?? "").toUpperCase();
  const disposition: ProviderReviewFeedback["disposition"] = state === "CHANGES_REQUESTED"
    ? "changes-requested"
    : /\?/.test(body) || /\b(?:why|how|could you explain)\b/i.test(body)
      ? "question"
      : source === "review-comment" && (record.suggested_change !== undefined || /\bshould\b|\bplease\b|\bchange\b/i.test(body))
        ? "suggestion"
        : "comment";
  const createdAt = typeof record.created_at === "string" ? record.created_at : new Date(0).toISOString();
  const updatedAt = typeof record.updated_at === "string" ? record.updated_at : undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return [];
  const reviewId = Number(record.pull_request_review_id);
  const line = Number(record.line ?? record.original_line);
  const commitSha = typeof record.commit_id === "string" && /^[0-9a-f]{7,64}$/i.test(record.commit_id) ? record.commit_id : undefined;
  return [{
    pullRequestId,
    pullRequestNumber,
    ...(source === "review" ? { reviewId: id } : {}),
    ...(source === "review-comment" && Number.isInteger(reviewId) && reviewId > 0 ? { reviewId } : {}),
    ...(source === "review-comment" && typeof record.in_reply_to_id === "number" ? { threadId: String(record.in_reply_to_id) } : {}),
    ...(source !== "issue-comment" ? { commentId: source === "review-comment" ? id : undefined } : { commentId: id }),
    author,
    authorType: userType,
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    source,
    disposition,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    ...(commitSha ? { candidateSha: commitSha } : {}),
    body,
    ...(record.resolved === true ? { resolved: true } : {})
  }];
}

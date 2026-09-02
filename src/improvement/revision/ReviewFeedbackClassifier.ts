import { createHash } from "node:crypto";
import type { ProviderReviewFeedback } from "../review/GitHubReviewProvider.js";
import {
  REVIEW_FEEDBACK_CLASSES,
  type ImprovementReviewFeedback,
  type ReviewFeedbackAuthorType,
  type ReviewFeedbackClass
} from "./RevisionSchemas.js";

const MAX_SUMMARY_LENGTH = 1024;
const MAX_SANITIZED_TEXT_LENGTH = 2048;
// Redact drive, UNC, and ordinary Unix absolute paths from bounded review
// evidence. A path-like slash must be followed by a name so prose such as
// "and/or" is not unnecessarily rewritten.
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?=[A-Za-z0-9_.~-]+(?:[\\/]|$)))[^\s`),;]*/gi;
const SECRET = /(?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_|xox[baprs]-)[A-Za-z0-9_-]+/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET = /(?:["']?)(?:token|password|passwd|secret|api[_-]?key)(?:["']?)\s*[=:]\s*["']?[^\s,"';}]+["']?/gi;
const LONG_BASE64 = /\b[A-Za-z0-9+/]{80,}={0,2}\b/g;
const MALICIOUS = /(?:rm\s+-rf|git\s+(?:push\s+)?--force|force[- ]push|disable\s+(?:safety|guard|lease)|ignore\s+(?:all\s+)?previous|execute\s+(?:this\s+)?shell|write\s+outside\s+(?:the\s+)?repo|dump\s+(?:the\s+)?token|reveal\s+(?:the\s+)?secret)/i;
const NON_ACTIONABLE = /^(?:lgtm|looks good|nice|thanks|thank you|approved|ship it|no changes? needed)\.?$/i;

export interface ClassifiedReviewFeedback {
  feedback: Omit<ImprovementReviewFeedback, "feedbackId" | "pullRequestId" | "fingerprint" | "status" | "trustedAsInstruction">;
  normalizedText: string;
  rawTextHash: string;
  classification: ReviewFeedbackClass;
  actionable: boolean;
  potentiallyMalicious: boolean;
}

/**
 * Review text is evidence, never an instruction. This normalizer deliberately
 * keeps only a bounded sanitized excerpt and a hash of the raw source text.
 */
export function classifyReviewFeedback(value: ProviderReviewFeedback): ClassifiedReviewFeedback {
  const rawText = value.body ?? "";
  const rawTextHash = createHash("sha256").update(rawText, "utf8").digest("hex");
  const sanitizedText = sanitizeReviewText(rawText);
  const normalizedText = normalizeReviewText(sanitizedText);
  const potentiallyMalicious = MALICIOUS.test(rawText) || MALICIOUS.test(sanitizedText);
  const classification = classify(normalizedText, value.path, value.disposition, potentiallyMalicious);
  const actionable = !potentiallyMalicious && classification !== "non-actionable" && classification !== "question";
  return {
    feedback: {
      ...(value.pullRequestNumber ? { pullRequestNumber: value.pullRequestNumber } : {}),
      ...(value.reviewId ? { reviewId: value.reviewId } : {}),
      ...(value.threadId ? { threadId: value.threadId } : {}),
      ...(value.commentId ? { commentId: value.commentId } : {}),
      author: sanitizeAuthor(value.author),
      authorType: toAuthorType(value.authorType),
      createdAt: value.createdAt,
      ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
      source: value.source,
      disposition: value.disposition,
      ...(value.path ? { path: sanitizePath(value.path) } : {}),
      ...(value.line ? { line: value.line } : {}),
      ...(value.candidateSha ? { candidateSha: value.candidateSha } : {}),
      rawTextHash,
      ...(normalizedText ? { sanitizedText: normalizedText.slice(0, MAX_SANITIZED_TEXT_LENGTH) } : {}),
      normalizedSummary: (normalizedText || "(empty review body)").slice(0, MAX_SUMMARY_LENGTH),
      classification,
      reason: potentiallyMalicious ? "Review text was classified as untrusted or potentially malicious evidence." : undefined
    },
    normalizedText,
    rawTextHash,
    classification,
    actionable,
    potentiallyMalicious
  };
}

export function sanitizeReviewText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(SECRET, "<redacted-secret>")
    .replace(BEARER, "Bearer <redacted-secret>")
    .replace(KEY_VALUE_SECRET, "<redacted-secret>")
    .replace(LONG_BASE64, "<redacted-blob>")
    .replace(ABSOLUTE_PATH, "<redacted-path>")
    .replace(/[\r\n\t ]+/g, " ")
    .trim()
    .slice(0, MAX_SANITIZED_TEXT_LENGTH);
}

export function normalizeReviewText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "<code>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY_LENGTH);
}

export function feedbackFingerprint(input: {
  pullRequestId: string;
  source: string;
  threadId?: string;
  commentId?: number;
  reviewId?: number;
  path?: string;
  line?: number;
  rawTextHash: string;
  classification: ReviewFeedbackClass;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...input, path: input.path?.replace(/\\/g, "/") }), "utf8")
    .digest("hex");
}

export function reviewFeedbackIdentity(value: ProviderReviewFeedback): string {
  const identity = value.commentId !== undefined
    ? `comment:${value.commentId}`
    : value.reviewId !== undefined
      ? `review:${value.reviewId}`
      : value.threadId
        ? `thread:${value.threadId}`
        : `body:${value.createdAt}:${value.author}`;
  return `${value.pullRequestId}:${value.source}:${identity}`;
}

function classify(text: string, path: string | undefined, disposition: ProviderReviewFeedback["disposition"], malicious: boolean): ReviewFeedbackClass {
  if (malicious) return "potentially-malicious";
  if (NON_ACTIONABLE.test(text)) return "non-actionable";
  if (disposition === "question" || /\?|\b(?:why|how|what if|could you explain)\b/i.test(text)) return "question";
  const normalizedPath = (path ?? "").replace(/\\/g, "/").toLowerCase();
  if (/^(?:tests?|__tests__)\/|\.test\.[^/]+$|spec\//i.test(normalizedPath)) return "test-coverage";
  if (/(?:^|\/)(?:readme|docs?|skills?|\.github)(?:\/|\.|$)/i.test(normalizedPath)) return "documentation";
  if (/src\/mcp\/(?:tools|toolschemas|toolhandlers)|tool[-_ ]surface/i.test(`${normalizedPath} ${text}`)) return "tool-surface";
  if (/capabilit|safety profile|approval|permission|policy/i.test(`${normalizedPath} ${text}`)) return "capability-policy";
  if (/flash|lease|fenc|credential|secret|unsafe|danger|reset protection|memory write|security/i.test(text)) return "safety";
  if (/boot|ipc|workflow|cpu2|handoff|daemon|worker|job/i.test(text)) return "workflow";
  if (/error|message|guidance|diagnos|remediation/i.test(text)) return "error-guidance";
  if (/performance|slow|latency|timeout|timing|cycle|throughput/i.test(text)) return "performance";
  if (/architecture|redesign|refactor|service boundary|module/i.test(text)) return "architecture";
  if (/style|format|naming|nit|typo|lint/i.test(text)) return "style";
  if (/bug|wrong|incorrect|crash|throw|fail|regression|null|undefined|race/i.test(text)) return "correctness";
  return disposition === "suggestion" || disposition === "changes-requested" ? "correctness" : "non-actionable";
}

function sanitizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (/^(?:[A-Za-z]:\/|\/|\.\.\/?)/.test(normalized)) return "<redacted-path>";
  return normalized.slice(0, 512);
}

function sanitizeAuthor(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128) || "unknown";
}

function toAuthorType(value: ProviderReviewFeedback["authorType"]): ReviewFeedbackAuthorType {
  return value === "human" || value === "bot" ? value : "unknown";
}

export function reviewFeedbackClassValues(): readonly ReviewFeedbackClass[] {
  return REVIEW_FEEDBACK_CLASSES;
}

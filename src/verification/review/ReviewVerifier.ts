import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AtomicArtifactWriter } from "../../artifacts/AtomicArtifactWriter.js";
import type {
  VerificationArtifact,
  VerificationCheck,
  VerificationResult
} from "../VerificationSchemas.js";
import type { VerificationExecutionContext } from "../VerificationResultBuilder.js";
import {
  createVerificationResult,
  gateFailuresFromChecks,
  incomplete,
  statusFromChecks
} from "../VerificationResultBuilder.js";
import {
  reviewResultSchema,
  reviewVerificationInputSchema,
  type ReviewResult,
  type ReviewRules,
  type ReviewVerificationInput
} from "./ReviewSchemas.js";

export interface ReviewVerificationOutput {
  verification: VerificationResult;
  review: ReviewResult;
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  addedLines: Array<{ line: number; text: string }>;
}

interface DiffSummary {
  files: DiffFile[];
  added: number;
  removed: number;
}

export interface ReviewVerifierOptions {
  rootDirectory: string;
  writer?: AtomicArtifactWriter;
}

/**
 * Deterministic review checks. This verifier never invokes Git or an LLM. A
 * caller may provide diffText on an offline machine, or point at a trusted
 * diffPath that has already passed the normal filesystem policy.
 */
export class ReviewVerifier {
  private readonly writer: AtomicArtifactWriter;

  constructor(private readonly options: ReviewVerifierOptions) {
    this.writer = options.writer ?? new AtomicArtifactWriter();
  }

  async verify(rawInput: unknown, context: VerificationExecutionContext): Promise<ReviewVerificationOutput> {
    const input = reviewVerificationInputSchema.parse(rawInput);
    const started = new Date();
    const artifactDirectory = context.artifactDirectory ?? path.join(path.resolve(this.options.rootDirectory), "verification", safePath(context.verificationId));
    await this.writer.ensureDirectory(artifactDirectory);
    const diagnostics: VerificationResult["diagnostics"] = [];
    let diffText = input.diffText;
    if (diffText === undefined && input.diffPath) {
      try {
        diffText = await readFile(path.resolve(input.diffPath), "utf8");
      } catch (error) {
        diagnostics.push({ code: "DIFF_READ_FAILED", severity: "ERROR", message: `Unable to read diff: ${String(error)}`, source: input.diffPath });
      }
    }
    const diff = diffText === undefined ? emptyDiff(input.changedFiles ?? []) : parseUnifiedDiff(diffText);
    const changedFiles = unique([...diff.files.map(file => file.path), ...(input.changedFiles ?? []).map(normalizePath)]);
    const checks: VerificationCheck[] = [];
    const requirements: ReviewResult["requirements"] = [];
    const rules = input.rules;

    if (diffText !== undefined) {
      const diffPath = path.join(artifactDirectory, "evidence", "review.diff");
      await this.writer.writeText(diffPath, diffText);
    }
    const diffArtifact = diffText === undefined ? null : await fileArtifact(path.join(artifactDirectory, "evidence", "review.diff"));

    for (const file of changedFiles) {
      for (const forbiddenPath of rules.forbiddenPaths) {
        if (matchesPath(file, forbiddenPath)) {
          checks.push(check(`forbidden-path:${forbiddenPath}:${file}`, "path-policy", "FAILED", "CRITICAL", `Changed file matches forbidden path: ${file}`, { expected: `not ${forbiddenPath}`, actual: file, file }));
        }
      }
      for (const generatedPath of rules.generatedPaths) {
        if (matchesPath(file, generatedPath)) {
          checks.push(check(`generated-path:${generatedPath}:${file}`, "generated-artifact", "FAILED", "WARNING", `Generated file changed; source-of-truth review is required: ${file}`, { expected: `review source for ${generatedPath}`, actual: file, file }));
        }
      }
    }

    const changedLines = {
      added: diff.added,
      removed: diff.removed,
      total: diff.added + diff.removed
    };
    if (diffText === undefined && changedFiles.length === 0) {
      checks.push(check("diff-readable", "input", "BLOCKED", "CRITICAL", "Diff evidence could not be read and no changed-file metadata was supplied", { expected: "diffText, readable diffPath, or changedFiles", actual: null }));
    }
    if (rules.maxChangedLines !== null) {
      checks.push(changedLines.total <= rules.maxChangedLines
        ? check("max-changed-lines", "diff-metadata", "PASSED", "INFO", "Changed line count is within the configured limit", { expected: rules.maxChangedLines, actual: changedLines.total })
        : check("max-changed-lines", "diff-metadata", "FAILED", "ERROR", "Changed line count exceeds the configured limit", { expected: rules.maxChangedLines, actual: changedLines.total }));
    } else {
      checks.push(check("diff-metadata", "diff-metadata", "PASSED", "INFO", `Diff metadata collected for ${changedFiles.length} changed file(s)`, { actual: changedLines }));
    }

    for (const rule of rules.forbiddenPatterns) {
      let expression: RegExp;
      try {
        expression = new RegExp(rule.pattern, rule.flags);
      } catch (error) {
        diagnostics.push({ code: "REVIEW_RULE_INVALID", severity: "ERROR", message: `Invalid review rule ${rule.id ?? rule.pattern}: ${String(error)}`, source: "forbiddenPatterns" });
        checks.push(check(`forbidden-pattern:${rule.id ?? rule.pattern}`, "rule-config", "FAILED", "CRITICAL", "Configured forbidden pattern is invalid", { actual: String(error) }));
        continue;
      }
      const matches = diff.files.flatMap(file => file.addedLines
        .filter(line => {
          expression.lastIndex = 0;
          return expression.test(line.text);
        })
        .map(line => ({ file: file.path, line: line.line, text: line.text })));
      if (matches.length > 0) {
        checks.push(check(`forbidden-pattern:${rule.id ?? rule.pattern}`, "forbidden-pattern", "FAILED", rule.severity, rule.message ?? "Configured forbidden pattern matched added code", { expected: "no match", actual: matches, source: rule.pattern, evidence: matches }));
      } else {
        checks.push(check(`forbidden-pattern:${rule.id ?? rule.pattern}`, "forbidden-pattern", "PASSED", "INFO", rule.message ?? "Configured forbidden pattern did not match added code", { expected: "no match", actual: 0, source: rule.pattern }));
      }
    }

    const realtimePatterns = [...rules.highFrequencyPaths, ...rules.realtimePaths.map(item => item.path)];
    const requirementChecks = [
      requirement("realtime-review", realtimePatterns, changedFiles, input.evidence.realtimeReviewId, "realtime-review", "A changed realtime/high-frequency path requires realtime review evidence"),
      requirement("map-verification", rules.linkerPaths, changedFiles, input.evidence.mapVerificationId, "map-verification", "A changed linker path requires map verification evidence"),
      requirement("interface-review", rules.interfacePaths, changedFiles, input.evidence.interfaceReviewId, "interface-review", "A changed CPU/CLA interface path requires interface review evidence"),
      requirement("ipc-review", rules.ipcPaths, changedFiles, input.evidence.ipcReviewId, "ipc-review", "A changed IPC path requires IPC review evidence")
    ];
    for (const item of requirementChecks) {
      if (!item.triggered) continue;
      requirements.push({ id: item.id, required: true, satisfied: Boolean(item.evidenceId), evidenceId: item.evidenceId ?? null });
      checks.push(item.evidenceId
        ? check(item.id, "required-evidence", "PASSED", "INFO", `${item.message}; evidence is linked`, { evidence: item.evidenceId })
        : check(item.id, "required-evidence", "BLOCKED", "CRITICAL", `${item.message}; no evidence id was supplied`, { expected: "verification evidence id", actual: null }));
    }
    for (const companion of rules.requiredCompanionFiles) {
      const triggered = changedFiles.some(file => matchesPath(file, companion.trigger) || file.includes(companion.trigger));
      if (!triggered) continue;
      const missing = companion.files.filter(required => !changedFiles.some(file => matchesPath(file, required)));
      requirements.push({ id: `companion:${companion.trigger}`, required: true, satisfied: missing.length === 0, evidenceId: null });
      checks.push(missing.length === 0
        ? check(`companion:${companion.trigger}`, "required-companion", "PASSED", "INFO", "Required companion files are included", { expected: companion.files, actual: changedFiles })
        : check(`companion:${companion.trigger}`, "required-companion", "BLOCKED", "CRITICAL", "Required companion files are missing", { expected: companion.files, actual: missing }));
    }
    if (rules.highFrequencyPaths.length === 0 && rules.linkerPaths.length === 0 && rules.interfacePaths.length === 0 && rules.ipcPaths.length === 0) {
      checks.push(check("review-rules-configured", "rule-config", "SKIPPED", "INFO", "No path-triggered companion review rules are configured"));
    }

    const hardGateFailures = gateFailuresFromChecks("review", checks);
    const status = diffText === undefined && changedFiles.length === 0
      ? "BLOCKED"
      : checks.some(check => check.status === "BLOCKED") ? "BLOCKED" : statusFromChecks(checks, "PASSED");
    const reviewStatus: ReviewResult["status"] = status;
    const decision = decisionFor(reviewStatus, checks);
    const counts = {
      checks: checks.length,
      passed: checks.filter(item => item.status === "PASSED").length,
      failed: checks.filter(item => item.status === "FAILED").length,
      blocked: checks.filter(item => item.status === "BLOCKED").length,
      skipped: checks.filter(item => item.status === "SKIPPED").length
    };
    const ended = new Date();
    const review = reviewResultSchema.parse({
      schemaVersion: 1,
      status: reviewStatus,
      changedFiles,
      changedLines,
      counts,
      checks: checks.map(item => ({
        id: item.id,
        status: item.status,
        severity: item.severity,
        message: item.message,
        ...(item.file ? { file: item.file } : {}),
        ...(item.line ? { line: item.line } : {}),
        ...(item.evidence !== undefined ? { evidence: item.evidence } : {})
      })),
      requirements,
      decision,
      durationMs: elapsed(started, ended)
    });
    const verification = createVerificationResult({
      context,
      verifierType: "review",
      status: reviewStatus,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      checks,
      diagnostics,
      artifacts: diffArtifact ? [diffArtifact] : [],
      completeness: diffText === undefined && changedFiles.length === 0
        ? incomplete("REVIEW_INPUT_MISSING")
        : { status: "COMPLETE", reason: null, requiredArtifacts: [], presentArtifacts: diffArtifact ? [diffArtifact.path] : [] },
      hardGateFailures,
      inputs: {
        changedFiles,
        ...(input.diffPath ? { diffPath: input.diffPath } : {}),
        evidence: input.evidence,
        rules: input.rules
      },
      details: { review }
    });
    return { verification, review };
  }
}

function requirement(
  id: string,
  patterns: string[],
  changedFiles: string[],
  evidenceId: string | undefined,
  _category: string,
  message: string
): { id: string; triggered: boolean; evidenceId?: string; message: string } {
  const triggered = patterns.some(pattern => changedFiles.some(file => matchesPath(file, pattern)));
  return { id, triggered, ...(evidenceId ? { evidenceId } : {}), message };
}

function parseUnifiedDiff(diffText: string): DiffSummary {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let newLine = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const filePath = match?.[2] ?? "";
      current = filePath ? { path: normalizePath(filePath), additions: 0, deletions: 0, addedLines: [] } : undefined;
      if (current) files.push(current);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4).split("\t", 1)[0] ?? "";
      if (value !== "/dev/null") {
        const filePath = normalizePath(value.replace(/^b\//, ""));
        if (!current || current.path !== filePath) {
          current = { path: filePath, additions: 0, deletions: 0, addedLines: [] };
          files.push(current);
        }
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = hunk ? Number(hunk[1]) : 0;
      continue;
    }
    if (!current || newLine === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      current.additions += 1;
      current.addedLines.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    } else {
      newLine += 1;
    }
  }
  return { files, added: files.reduce((sum, file) => sum + file.additions, 0), removed: files.reduce((sum, file) => sum + file.deletions, 0) };
}

function emptyDiff(changedFiles: string[]): DiffSummary {
  return { files: unique(changedFiles.map(normalizePath)).map(file => ({ path: file, additions: 0, deletions: 0, addedLines: [] })), added: 0, removed: 0 };
}

function decisionFor(status: ReviewResult["status"], checks: VerificationCheck[]): ReviewResult["decision"] {
  if (status === "BLOCKED" || status === "UNSUPPORTED") return "BLOCK";
  if (checks.some(check => check.status === "FAILED" && (check.severity === "CRITICAL" || check.severity === "ERROR"))) return "REJECT";
  if (status === "FAILED") return "REQUIRES_REVIEW";
  return "PASS";
}

function matchesPath(filePath: string, pattern: string): boolean {
  const file = normalizePath(filePath);
  const candidate = normalizePath(pattern);
  if (!candidate.includes("*") && !candidate.includes("?")) return file === candidate || file.endsWith(`/${candidate}`);
  const expression = globRegex(candidate);
  return expression.test(file);
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
      source += ".*";
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$+.()|{}[\]]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${source}$`, "i");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^a\//, "").replace(/^b\//, "");
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

async function fileArtifact(filePath: string): Promise<VerificationArtifact | null> {
  try {
    const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
    if (!metadata.isFile()) return null;
    return { path: path.resolve(filePath), artifactType: "verification:review-diff", sha256: createHash("sha256").update(bytes).digest("hex"), size: metadata.size, mtimeMs: metadata.mtimeMs, completeness: "COMPLETE", role: "evidence" };
  } catch {
    return null;
  }
}

function check(
  id: string,
  category: string,
  status: VerificationCheck["status"],
  severity: VerificationCheck["severity"],
  message: string,
  values: { expected?: unknown; actual?: unknown; source?: string; evidence?: unknown; file?: string; line?: number } = {}
): VerificationCheck { return { id, category, status, severity, message, ...values }; }

function elapsed(start: Date, end: Date): number { return Math.max(0, end.getTime() - start.getTime()); }

function safePath(value: string): string {
  return value.split(/[\\/]/).map(part => part.replace(/[^A-Za-z0-9._-]/g, "_")).filter(Boolean).join(path.sep);
}

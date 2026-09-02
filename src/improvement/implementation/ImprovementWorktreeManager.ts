import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ImprovementProposal } from "../ProposalSchemas.js";
import { DebugMcpError } from "../../utils/errors.js";
import { processSucceeded, runProcess, type ProcessRunResult } from "./ProcessRunner.js";
import type { GitSnapshot } from "./ImplementationSchemas.js";

export interface ImprovementWorktreeManagerOptions {
  repositoryRoot: string;
  worktreeRoot: string;
  now?: () => number;
  gitTimeoutMs?: number;
}

export interface WorktreeHandle {
  path: string;
  branchName: string;
  baselineSha: string;
}

export interface ScopeCheckResult {
  snapshot: GitSnapshot;
  changedFiles: string[];
  diffPatch: string;
  diffSha256: string;
}

export type ManagedWorkspaceSnapshot = Readonly<Record<string, string>>;

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const SAFE_BRANCH = /^(?:improve|auto-improve)\/[A-Za-z0-9._-]{1,220}$/;
const FORBIDDEN_GENERATED_PREFIXES = ["dist/", "coverage/", "node_modules/", "runtime/"];
const BINARY_EXTENSIONS = new Set([".exe", ".dll", ".zip", ".node", ".bin"]);
const PROPOSAL_TEXT_FOR_PACKAGING = /\b(packaging|package|offline-runtime|offline bundle)\b/i;

/** Owns only Git/worktree operations for an improvement candidate. */
export class ImprovementWorktreeManager {
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  private readonly now: () => number;
  private readonly gitTimeoutMs: number;

  constructor(options: ImprovementWorktreeManagerOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.worktreeRoot = path.resolve(options.worktreeRoot);
    this.now = options.now ?? (() => Date.now());
    this.gitTimeoutMs = Math.max(1_000, Math.trunc(options.gitTimeoutMs ?? 30_000));
    if (this.worktreeRoot === this.repositoryRoot || isWithin(this.repositoryRoot, this.worktreeRoot)) {
      throw new DebugMcpError("WorkspaceBoundaryViolation", "Improvement worktrees must be outside the source repository", {
        repositoryRoot: this.repositoryRoot,
        worktreeRoot: this.worktreeRoot
      });
    }
  }

  async resolveRef(ref: string): Promise<string> {
    assertRef(ref);
    const result = await this.runGitAt(this.repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`], "BaselineUnavailable");
    const sha = result.stdout.trim();
    if (!SHA_PATTERN.test(sha)) {
      throw new DebugMcpError("BaselineUnavailable", `Git ref does not resolve to a commit: ${ref}`, {
        ref,
        stdout: result.stdout.trim()
      });
    }
    return sha;
  }

  async createCandidate(baselineSha: string, branchName: string, runId: string): Promise<WorktreeHandle> {
    assertSha(baselineSha);
    assertBranch(branchName);
    const candidatePath = await this.allocatePath(runId);
    await mkdir(path.dirname(candidatePath), { recursive: true });
    const result = await this.runGitAt(this.repositoryRoot, ["worktree", "add", "-b", branchName, candidatePath, baselineSha], "WorktreeInitializationFailed");
    if (!processSucceeded(result)) {
      throw gitFailure("WorktreeInitializationFailed", "Git could not create the isolated candidate worktree", result, {
        baselineSha,
        branchName,
        worktreePath: candidatePath
      });
    }
    try {
      const snapshot = await this.snapshot(candidatePath, baselineSha);
      if (snapshot.headSha.toLowerCase() !== baselineSha.toLowerCase() || !snapshot.clean) {
        throw new DebugMcpError("WorktreeInitializationFailed", "Candidate worktree did not start at a clean baseline", {
          baselineSha,
          actualHeadSha: snapshot.headSha,
          clean: snapshot.clean,
          worktreePath: candidatePath
        });
      }
    } catch (error) {
      await this.remove(candidatePath).catch(() => undefined);
      throw error;
    }
    return { path: candidatePath, branchName, baselineSha };
  }

  async createBaseline(baselineSha: string, runId: string): Promise<string> {
    assertSha(baselineSha);
    const baselinePath = await this.allocatePath(`baseline-${runId}`);
    await mkdir(path.dirname(baselinePath), { recursive: true });
    const result = await this.runGitAt(this.repositoryRoot, ["worktree", "add", "--detach", baselinePath, baselineSha], "WorktreeInitializationFailed");
    if (!processSucceeded(result)) {
      throw gitFailure("WorktreeInitializationFailed", "Git could not create the baseline replay worktree", result, {
        baselineSha,
        worktreePath: baselinePath
      });
    }
    try {
      const snapshot = await this.snapshot(baselinePath, baselineSha);
      if (snapshot.headSha.toLowerCase() !== baselineSha.toLowerCase() || !snapshot.clean) {
        throw new DebugMcpError("WorktreeInitializationFailed", "Baseline replay worktree is not clean at the approved baseline", {
          baselineSha,
          actualHeadSha: snapshot.headSha,
          clean: snapshot.clean,
          worktreePath: baselinePath
        });
      }
    } catch (error) {
      await this.remove(baselinePath).catch(() => undefined);
      throw error;
    }
    return baselinePath;
  }

  async remove(worktreePath: string): Promise<void> {
    const resolved = path.resolve(worktreePath);
    this.assertManagedPath(resolved);
    if (resolved === this.worktreeRoot) {
      throw new DebugMcpError("WorkspaceBoundaryViolation", "Refusing to remove the managed worktree root", { worktreePath: resolved, worktreeRoot: this.worktreeRoot });
    }
    const result = await this.runGitAt(this.repositoryRoot, ["worktree", "remove", "--force", resolved], "WorktreeCleanupFailed");
    if (!processSucceeded(result)) {
      throw gitFailure("WorktreeCleanupFailed", "Git could not remove the improvement worktree", result, { worktreePath: resolved });
    }
    try {
      await lstat(resolved);
      throw new DebugMcpError("WorktreeCleanupFailed", "Git reported success but the improvement worktree still exists", { worktreePath: resolved });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }

  async snapshot(worktreePath: string, baselineSha?: string): Promise<GitSnapshot> {
    this.assertManagedPath(worktreePath, true);
    if (baselineSha) assertSha(baselineSha);
    const cwd = path.resolve(worktreePath);
    const [head, branch, status, names, stat] = await Promise.all([
      this.runGitAt(cwd, ["rev-parse", "HEAD"], "WorktreeInitializationFailed"),
      this.runGitAt(cwd, ["branch", "--show-current"], "WorktreeInitializationFailed"),
      this.runGitAt(cwd, ["status", "--short"], "WorktreeInitializationFailed"),
      this.changedFiles(cwd, baselineSha),
      this.runGitAt(cwd, baselineSha ? ["diff", "--stat", baselineSha, "--"] : ["diff", "--stat"], "WorktreeInitializationFailed")
    ]);
    if (!processSucceeded(head) || !processSucceeded(branch) || !processSucceeded(status) || !processSucceeded(stat)) {
      throw new DebugMcpError("WorktreeInitializationFailed", "Unable to inspect improvement worktree Git state", {
        worktreePath: cwd,
        head: summarizeProcess(head),
        branch: summarizeProcess(branch),
        status: summarizeProcess(status),
        stat: summarizeProcess(stat)
      });
    }
    const statusShort = status.stdout.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
    return {
      headSha: head.stdout.trim(),
      ...(branch.stdout.trim() ? { branchName: branch.stdout.trim() } : {}),
      clean: statusShort.length === 0,
      statusShort,
      changedFiles: names,
      ...(stat.stdout.trim() ? { diffStat: stat.stdout.trim() } : {}),
      capturedAt: new Date(this.now()).toISOString()
    };
  }

  /**
   * Capture files outside one candidate worktree but inside the dedicated
   * improvement root. This catches the common ../ escape on platforms where
   * an external coding-agent process cannot be OS-sandboxed by this service.
   */
  async captureManagedWorkspace(worktreePath: string): Promise<ManagedWorkspaceSnapshot> {
    this.assertManagedPath(worktreePath, true);
    return collectManagedEntries(this.worktreeRoot, path.resolve(worktreePath));
  }

  async assertManagedWorkspaceUnchanged(worktreePath: string, before: ManagedWorkspaceSnapshot): Promise<void> {
    const after = await this.captureManagedWorkspace(worktreePath);
    const changed = changedSnapshotKeys(before, after);
    if (changed.length > 0) {
      throw new DebugMcpError("WorkspaceBoundaryViolation", "The coding agent changed files outside its assigned improvement worktree", {
        worktreeRoot: this.worktreeRoot,
        worktreePath: path.resolve(worktreePath),
        changedPaths: changed.slice(0, 128)
      });
    }
  }

  async captureSourceStatus(): Promise<readonly string[]> {
    const result = await this.runGitAt(this.repositoryRoot, ["status", "--short"], "WorkspaceBoundaryViolation");
    if (!processSucceeded(result)) {
      throw gitFailure("WorkspaceBoundaryViolation", "Unable to inspect the source worktree before agent execution", result, {
        repositoryRoot: this.repositoryRoot
      });
    }
    return result.stdout.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  }

  async assertSourceStatusUnchanged(before: readonly string[]): Promise<void> {
    const after = await this.captureSourceStatus();
    if (before.length !== after.length || before.some((line, index) => line !== after[index])) {
      throw new DebugMcpError("WorkspaceBoundaryViolation", "The coding agent changed the source worktree outside the assigned improvement worktree", {
        repositoryRoot: this.repositoryRoot,
        before: before.slice(0, 128),
        after: after.slice(0, 128)
      });
    }
  }

  async changedFiles(worktreePath: string, baselineSha?: string): Promise<string[]> {
    this.assertManagedPath(worktreePath, true);
    const cwd = path.resolve(worktreePath);
    const tracked = await this.runGitAt(
      cwd,
      baselineSha ? ["diff", "--name-only", baselineSha, "--"] : ["diff", "--name-only", "--"],
      "WorktreeInitializationFailed"
    );
    const cached = await this.runGitAt(cwd, ["diff", "--cached", "--name-only", "--"], "WorktreeInitializationFailed");
    const untracked = await this.runGitAt(cwd, ["ls-files", "--others", "--exclude-standard"], "WorktreeInitializationFailed");
    for (const result of [tracked, cached, untracked]) {
      if (!processSucceeded(result)) throw gitFailure("WorktreeInitializationFailed", "Unable to enumerate candidate changes", result, { worktreePath: cwd });
    }
    return Array.from(new Set([
      ...tracked.stdout.split(/\r?\n/),
      ...cached.stdout.split(/\r?\n/),
      ...untracked.stdout.split(/\r?\n/)
    ].map(value => normalizeRepoPath(value)).filter(Boolean))).sort();
  }

  async diffPatch(worktreePath: string, baselineSha: string): Promise<string> {
    this.assertManagedPath(worktreePath, true);
    assertSha(baselineSha);
    const cwd = path.resolve(worktreePath);
    const tracked = await this.runGitAt(cwd, ["diff", "--binary", baselineSha, "--"], "ScopeViolation");
    if (!processSucceeded(tracked)) throw gitFailure("ScopeViolation", "Unable to collect candidate diff", tracked, { worktreePath: cwd, baselineSha });
    const untracked = await this.changedFiles(cwd, baselineSha);
    const trackedNamesResult = await this.runGitAt(cwd, ["diff", "--name-only", baselineSha, "--"], "ScopeViolation");
    if (!processSucceeded(trackedNamesResult)) throw gitFailure("ScopeViolation", "Unable to enumerate candidate diff paths", trackedNamesResult, { worktreePath: cwd, baselineSha });
    const trackedNames = new Set(trackedNamesResult.stdout.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean));
    const untrackedFiles = untracked.filter(file => !trackedNames.has(file));
    const additions: string[] = [];
    for (const file of untrackedFiles) {
      const absolute = path.resolve(cwd, file);
      this.assertPathWithin(absolute, cwd, "WorkspaceBoundaryViolation");
      const info = await lstat(absolute);
      if (!info.isFile()) continue;
      const content = await readFile(absolute, "utf8");
      additions.push(`\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split(/\r?\n/).length}\n+${content.replace(/\r?\n/g, "\n+")}`);
    }
    return tracked.stdout + additions.join("\n");
  }

  async validateScope(proposal: ImprovementProposal, worktreePath: string, baselineSha: string): Promise<ScopeCheckResult> {
    const snapshot = await this.snapshot(worktreePath, baselineSha);
    const changedFiles = snapshot.changedFiles;
    const normalizedAreas = proposal.proposedChange.allowedAreas.map(normalizeRepoPath).filter(Boolean);
    const forbiddenAreas = proposal.proposedChange.forbiddenAreas.map(normalizeRepoPath).filter(Boolean);
    const outside = changedFiles.filter(file => !normalizedAreas.some(area => file === area || file.startsWith(`${area}/`)));
    const forbidden = changedFiles.filter(file => forbiddenAreas.some(area => file === area || file.startsWith(`${area}/`)));
    const generated = changedFiles.filter(file => FORBIDDEN_GENERATED_PREFIXES.some(prefix => file === prefix.slice(0, -1) || file.startsWith(prefix)) || /(?:\.sqlite(?:-shm|-wal)?|\.log)$/i.test(file));
    const binary = changedFiles.filter(file => BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()));
    const dependency = changedFiles.filter(file => /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(file));
    const allowsPackaging = PROPOSAL_TEXT_FOR_PACKAGING.test(`${proposal.proposedChange.description} ${proposal.proposedChange.allowedAreas.join(" ")}`);
    const binaryViolation = binary.filter(file => !allowsPackaging || !/offline|package|dist/i.test(file));
    const packageJsonChanged = dependency.includes("package.json");
    const dependencyAllowed = dependency.every(file => normalizedAreas.includes(file))
      && /\b(dependenc(?:y|ies)|package\.json|package-lock|packaging|offline(?:[- ]runtime| bundle)?)\b/i.test(`${proposal.target} ${proposal.proposedChange.description}`);
    const lockfileOnly = dependency.includes("package-lock.json") && !packageJsonChanged;
    const symlinks = await this.findSymlinkChanges(worktreePath, changedFiles);
    const diff = await this.diffPatch(worktreePath, baselineSha);
    const diffCheck = await this.runGitAt(path.resolve(worktreePath), ["diff", "--check", baselineSha, "--"], "ScopeViolation");
    const violations = [
      ...outside.map(file => `outside allowedAreas: ${file}`),
      ...forbidden.map(file => `forbidden area: ${file}`),
      ...generated.map(file => `generated/runtime artifact: ${file}`),
      ...binaryViolation.map(file => `unexpected binary change: ${file}`),
      ...(dependency.length > 0 && !dependencyAllowed ? ["dependency manifest changes require explicit Proposal scope and dependency/package intent"] : []),
      ...(lockfileOnly ? ["lockfile-only dependency change is not permitted by default"] : []),
      ...symlinks.map(file => `symlink/junction change: ${file}`),
      ...(processSucceeded(diffCheck) ? [] : ["git diff --check reported whitespace errors"])
    ];
    if (violations.length > 0) {
      throw new DebugMcpError(violations.some(value => value.includes("symlink")) ? "WorkspaceBoundaryViolation" : violations.some(value => value.includes("binary")) ? "UnexpectedBinaryChange" : violations.some(value => value.includes("dependency")) ? "DependencyChangeNotAllowed" : "ScopeViolation", "Candidate changes are outside the approved implementation scope", {
        proposalId: proposal.proposalId,
        allowedAreas: normalizedAreas,
        forbiddenAreas,
        changedFiles,
        violations
      });
    }
    return { snapshot, changedFiles, diffPatch: diff, diffSha256: createHash("sha256").update(diff, "utf8").digest("hex") };
  }

  async runGitAt(cwd: string, args: readonly string[], failureCode: "BaselineUnavailable" | "WorktreeInitializationFailed" | "WorktreeCleanupFailed" | "ScopeViolation" | "WorkspaceBoundaryViolation" | "CandidateCommitFailed" = "WorktreeInitializationFailed"): Promise<ProcessRunResult> {
    this.assertManagedPath(cwd, true);
    return runProcess({
      command: "git",
      args,
      cwd: path.resolve(cwd),
      timeoutMs: this.gitTimeoutMs,
      env: sanitizedGitEnvironment()
    });
  }

  private async allocatePath(label: string): Promise<string> {
    const safeLabel = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "run";
    const candidate = path.resolve(this.worktreeRoot, safeLabel, "worktree");
    this.assertPathWithin(candidate, this.worktreeRoot, "WorkspaceBoundaryViolation");
    try {
      await lstat(candidate);
      throw new DebugMcpError("WorktreeInitializationFailed", "The improvement worktree path is already in use", { worktreePath: candidate });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return candidate;
  }

  private assertManagedPath(candidate: string, allowRepositoryRoot = false): void {
    const resolved = path.resolve(candidate);
    if (allowRepositoryRoot && resolved === this.repositoryRoot) return;
    if (!isWithin(this.worktreeRoot, resolved)) {
      throw new DebugMcpError("WorkspaceBoundaryViolation", "Git operation points outside the improvement worktree root", {
        worktreeRoot: this.worktreeRoot,
        worktreePath: resolved
      });
    }
  }

  private assertPathWithin(candidate: string, root: string, code: "WorkspaceBoundaryViolation" | "ScopeViolation"): void {
    if (!isWithin(path.resolve(root), path.resolve(candidate))) {
      throw new DebugMcpError(code, "Path escapes the controlled improvement workspace", { root: path.resolve(root), candidate: path.resolve(candidate) });
    }
  }

  private async findSymlinkChanges(worktreePath: string, files: readonly string[]): Promise<string[]> {
    const symlinks: string[] = [];
    for (const file of files) {
      const absolute = path.resolve(worktreePath, file);
      this.assertPathWithin(absolute, worktreePath, "WorkspaceBoundaryViolation");
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) symlinks.push(file);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      const mode = await this.runGitAt(path.resolve(worktreePath), ["ls-files", "-s", "--", file], "WorkspaceBoundaryViolation");
      if (processSucceeded(mode) && /^120000\s/.test(mode.stdout.trim())) symlinks.push(file);
    }
    return Array.from(new Set(symlinks));
  }
}

async function collectManagedEntries(root: string, excludedRoot: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  await walkManagedEntries(path.resolve(root), path.resolve(excludedRoot), path.resolve(root), entries);
  return entries;
}

async function walkManagedEntries(root: string, excludedRoot: string, current: string, entries: Record<string, string>): Promise<void> {
  let children;
  try {
    children = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const child of children) {
    const absolute = path.join(current, child.name);
    if (isWithin(excludedRoot, absolute)) continue;
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      entries[`${relative}/`] = "directory";
      await walkManagedEntries(root, excludedRoot, absolute, entries);
    } else if (info.isSymbolicLink()) {
      entries[relative] = `symlink:${info.size}:${info.mtimeMs}`;
    } else if (info.isFile()) {
      const content = await readFile(absolute);
      entries[relative] = `file:${createHash("sha256").update(content).digest("hex")}`;
    } else {
      entries[relative] = `other:${info.size}:${info.mtimeMs}`;
    }
  }
}

function changedSnapshotKeys(before: ManagedWorkspaceSnapshot, after: ManagedWorkspaceSnapshot): string[] {
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter(key => before[key] !== after[key])
    .sort();
}

function normalizeRepoPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:\//i.test(normalized)) {
    throw new DebugMcpError("WorkspaceBoundaryViolation", "Git reported a path outside the repository", { path: value });
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSha(value: string): void {
  if (!SHA_PATTERN.test(value)) throw new DebugMcpError("BaselineInvalid", "Improvement baseline must be a hexadecimal git SHA", { baselineSha: value });
}

function assertBranch(value: string): void {
  if (!SAFE_BRANCH.test(value)) throw new DebugMcpError("WorktreeInitializationFailed", "Improvement branch name is not in the controlled namespace", { branchName: value });
}

function assertRef(value: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("-")) throw new DebugMcpError("BaselineInvalid", "Improvement base ref contains unsupported characters", { ref: value });
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function gitFailure(code: "BaselineUnavailable" | "WorktreeInitializationFailed" | "WorktreeCleanupFailed" | "ScopeViolation" | "WorkspaceBoundaryViolation" | "CandidateCommitFailed", message: string, result: ProcessRunResult, details: Record<string, unknown>): DebugMcpError {
  return new DebugMcpError(code, message, {
    ...details,
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout.slice(-4096),
    stderr: result.stderr.slice(-4096)
  });
}

function summarizeProcess(result: ProcessRunResult): Record<string, unknown> {
  return { exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr.slice(-1024) };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

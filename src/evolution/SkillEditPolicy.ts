import {
  skillEditPolicySchema,
  skillEditSchema,
  type SkillEdit,
  type SkillEditPolicy
} from "./EvolutionSchemas.js";

export interface SkillEditValidation {
  valid: boolean;
  edits: SkillEdit[];
  counts: { additions: number; deletions: number; replacements: number };
  changedTokens: number;
  errors: string[];
}

/** Enforce bounded textual learning before a candidate is materialized. */
export function validateSkillEdits(rawEdits: unknown, rawPolicy: unknown = {}): SkillEditValidation {
  const policy = skillEditPolicySchema.parse(rawPolicy);
  const parsed = Array.isArray(rawEdits) ? rawEdits.flatMap(edit => {
    const result = skillEditSchema.safeParse(edit);
    return result.success ? [result.data] : [];
  }) : [];
  const errors: string[] = [];
  if (!Array.isArray(rawEdits)) errors.push("edits must be an array");
  if (parsed.length !== (Array.isArray(rawEdits) ? rawEdits.length : 0)) errors.push("one or more edits failed schema validation");
  const counts = {
    additions: parsed.filter(edit => edit.operation === "ADD").length,
    deletions: parsed.filter(edit => edit.operation === "DELETE").length,
    replacements: parsed.filter(edit => edit.operation === "REPLACE").length
  };
  if (counts.additions > policy.maxAdditions) errors.push(`addition limit exceeded: ${counts.additions} > ${policy.maxAdditions}`);
  if (counts.deletions > policy.maxDeletions) errors.push(`deletion limit exceeded: ${counts.deletions} > ${policy.maxDeletions}`);
  if (counts.replacements > policy.maxReplacements) errors.push(`replacement limit exceeded: ${counts.replacements} > ${policy.maxReplacements}`);
  if (!policy.allowFullRewrite && parsed.some(edit => isFullRewrite(edit))) errors.push("full-skill rewrite is disabled");
  const changedTokens = parsed.reduce((sum, edit) => sum + tokenCount(edit.content ?? ""), 0);
  if (changedTokens > policy.maxChangedTokens) errors.push(`changed-token limit exceeded: ${changedTokens} > ${policy.maxChangedTokens}`);
  return { valid: errors.length === 0, edits: parsed, counts, changedTokens, errors };
}

export function assertBoundedSkillEdits(rawEdits: unknown, rawPolicy: unknown = {}): SkillEdit[] {
  const validation = validateSkillEdits(rawEdits, rawPolicy);
  if (!validation.valid) throw new Error(`Skill edit policy rejected candidate: ${validation.errors.join("; ")}`);
  return validation.edits;
}

/** Apply only section-scoped edits to a candidate copy; this never writes production Skill files. */
export function applyBoundedSkillEdits(baseText: string, rawEdits: unknown, rawPolicy: unknown = {}): string {
  const policy: SkillEditPolicy = skillEditPolicySchema.parse(rawPolicy);
  const edits = assertBoundedSkillEdits(rawEdits, policy);
  let text = baseText.replace(/\r\n/g, "\n");
  for (const edit of edits) {
    if (isFullRewrite(edit)) throw new Error("Full-skill rewrite is disabled");
    const range = sectionRange(text, edit.section);
    if (edit.operation === "ADD") {
      if (range) {
        const before = text.slice(0, range.bodyEnd);
        const after = text.slice(range.bodyEnd);
        const prefix = before.endsWith("\n") ? "" : "\n";
        const suffix = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
        text = `${before}${prefix}${edit.content!}${suffix}${after}`;
      } else {
        text = `${text.trimEnd()}\n\n## ${edit.section}\n${edit.content!}\n`;
      }
    } else if (edit.operation === "DELETE") {
      if (!range) throw new Error(`Cannot delete missing skill section: ${edit.section}`);
      text = `${text.slice(0, range.start)}${text.slice(range.end)}`.replace(/\n{3,}/g, "\n\n");
    } else {
      if (!range) throw new Error(`Cannot replace missing skill section: ${edit.section}`);
      text = `${text.slice(0, range.bodyStart)}${edit.content!}\n${text.slice(range.bodyEnd)}`;
    }
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function tokenCount(value: string): number {
  return value.trim() === "" ? 0 : value.trim().split(/\s+/u).length;
}

function isFullRewrite(edit: SkillEdit): boolean {
  return edit.section === "*" || /^skill(?:\.md)?$/i.test(edit.section) || /^whole[-_ ]skill$/i.test(edit.section);
}

function sectionRange(text: string, section: string): { start: number; bodyStart: number; bodyEnd: number; end: number } | undefined {
  const lines = text.split("\n");
  const heading = new RegExp(`^(#{1,6})\\s+${escapeRegex(section)}\\s*$`, "i");
  let startLine = -1;
  let bodyStartLine = -1;
  let endLine = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (heading.test(lines[index] ?? "")) {
      startLine = index;
      bodyStartLine = index + 1;
      const level = (lines[index]!.match(/^#+/)?.[0].length ?? 1);
      for (let next = index + 1; next < lines.length; next += 1) {
        const nextLevel = lines[next]!.match(/^(#+)\s+/)?.[1].length;
        if (nextLevel !== undefined && nextLevel <= level) { endLine = next; break; }
      }
      break;
    }
  }
  if (startLine < 0) return undefined;
  const offsets = lineOffsets(lines);
  const bodyStart = bodyStartLine >= lines.length ? text.length : offsets[bodyStartLine]!;
  const bodyEnd = endLine >= lines.length ? text.length : offsets[endLine]!;
  return { start: offsets[startLine]!, bodyStart, bodyEnd, end: bodyEnd };
}

function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  return offsets;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

import { describe, expect, it } from "vitest";
import { applyBoundedSkillEdits, validateSkillEdits } from "../src/evolution/SkillEditPolicy.js";

const edit = (operation: "ADD" | "DELETE" | "REPLACE", section: string, content?: string) => ({ operation, section, ...(content !== undefined ? { content } : {}), reason: "evidence-backed change", evidenceIds: ["V1"] });

describe("bounded Skill edits", () => {
  it("applies section-scoped additions and rejects full rewrites", () => {
    const result = applyBoundedSkillEdits("# Skill\n\n## Rules\nold\n", [edit("ADD", "Rules", "new")], {});
    expect(result).toContain("old\nnew");
    expect(validateSkillEdits([edit("REPLACE", "SKILL.md", "rewrite")], {}).valid).toBe(false);
  });

  it("enforces operation and token budgets", () => {
    const validation = validateSkillEdits([edit("ADD", "A", "one two"), edit("ADD", "B", "three four")], { maxAdditions: 1, maxChangedTokens: 3 });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("addition limit"), expect.stringContaining("changed-token") ]));
  });
});

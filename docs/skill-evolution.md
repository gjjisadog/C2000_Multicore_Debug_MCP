# Skill evolution foundation

The MCP supplies deterministic evidence; it is not a model-driven Skill
rewriter. `skills/c2000-multicore-debug/SKILL.md` is the canonical base Skill
and `.skills/` is its generated repository mirror. Run:

```text
npm run sync:skills
npm run verify:skill-sync
```

The installer and offline bundle package the base Skill and the independent
`c2000-skill-improver` Skill. Production Skill files are never overwritten by
an evolution run.

## Data boundary

`src/evolution/EvolutionSchemas.ts` versions:

- `Experience`: a persisted verification/job fact, referenced by its
  `verificationId` and optional `jobId`/skill identity;
- `Lesson`: a repeated pattern that an improver derives across experiences;
- `CandidateSkill`: base version plus bounded edits and separated data-set ids;
- `EvolutionRun`: baseline/candidate scores, validation ids, hard-gate facts,
  and `PROMOTABLE`/`REJECTED` decision;
- `RejectedEdit`: a durable record of a failed candidate and why it failed.

Training, validation, and optional holdout verification ids are schema-checked
for disjointness. The improver must look for repeated patterns and inspect the
rejected-edit buffer before proposing a change.

## Bounded edits and promotion

Edits are only `ADD`, `DELETE`, or `REPLACE` and always include a named section,
reason, and evidence ids. The default policy allows at most two additions, one
deletion, one replacement, and 200 changed tokens; full rewrite is disabled.
`SkillEditPolicy` validates and can apply an edit to a candidate copy only.

`SkillPromotionGate` emits `PROMOTABLE` only when candidate score is strictly
greater than baseline, critical regression count is zero, required hard gates
pass, and required validation evidence is complete. Equal/lower scores,
critical regressions, incomplete evidence, and failed gates are `REJECTED`.
Rejections are appended atomically to `rejected-skill-edits.json`.

The gate is a selection boundary, not automatic promotion. A human or
agent-controlled review must decide whether a promotable candidate becomes a
new canonical Skill version.

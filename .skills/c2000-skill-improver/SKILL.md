---
name: c2000-skill-improver
description: Analyze persisted C2000 engineering-verification evidence and propose bounded, validated improvements to the c2000-multicore-debug Skill without automatic production promotion.
---

# C2000 Skill Improver

Use this independent Skill when the task is to learn from multiple completed
C2000 engineering runs and improve the base Skill. The improver does not run
an LLM inside the MCP and does not edit production `SKILL.md` automatically.

## Workflow

`Collect → Cluster failures → Find repeated pattern → Check rejected edits → Propose bounded edits → Build candidate → Run validation/holdout evals → Compare → PROMOTABLE or REJECTED`

Treat one run as Experience, a repeated cross-run pattern as Lesson, and a
validated stable strategy as Skill. Do not convert every failure into a
permanent rule. Read structured `VerificationResult` evidence, completeness,
hard-gate failures, evidence classification, job/verification identity, and
the relevant artifact paths.

## Candidate edit contract

Use only `ADD`, `DELETE`, or `REPLACE` edits scoped to a named section. Every
edit includes a reason and evidence ids. Enforce configured addition,
deletion, replacement, and token budgets. Full rewrites are rejected by
default. Keep training, validation, and holdout verification ids disjoint.

## Promotion gate

A candidate is `PROMOTABLE` only when its validation score is strictly higher
than baseline, critical regression count is zero, required hard gates pass, and
the required validation/holdout evidence is complete. Equal or lower scores,
critical regressions, incomplete evidence, and rejected hard gates are
`REJECTED` with a structured reason. Persist rejected edits with their scores,
validation ids, and failures so they are not proposed repeatedly.

Promotion is a controlled review step. Never overwrite the base Skill from an
improver run, and never claim a Mock or host-only result is hardware evidence.

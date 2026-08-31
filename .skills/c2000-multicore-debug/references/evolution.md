# Skill evolution boundary

The base Skill completes engineering work and consumes deterministic
verification facts. An independent `c2000-skill-improver` collects repeated
experience, clusters lessons, checks rejected edits, proposes bounded candidate
edits, and evaluates them on separated training/validation (and optional
holdout) sets.

Experience is one persisted run fact. A lesson is a repeated pattern across
experiences. A Skill rule is promoted only after held-out validation and a
strict promotion gate. One failure is not enough to create a permanent rule.

Candidate edits are bounded `ADD`, `DELETE`, or `REPLACE` operations with a
section, reason, and evidence ids. The edit policy limits additions,
deletions, replacements, and changed tokens; full rewrite is disabled by
default. A rejected edit is stored with scores, validation ids, and hard-gate
failures so the improver can avoid repeating it.

The MCP stores candidate/evaluation/rejected-edit data but never calls a model
and never overwrites production `SKILL.md`. Promotion emits `PROMOTABLE` or
`REJECTED`; a human/agent-controlled step owns any eventual production edit.

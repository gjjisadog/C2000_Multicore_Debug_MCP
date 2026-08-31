# Engineering verification reference

The preferred code-change path is `c2000_runEngineeringVerification`. It
creates related ids (`V/build`, `V/map`, `V/regression`, `V/review`), writes
atomic `result.json`, `verification.json`, `metrics.json`, logs/evidence, and a
manifest, and returns one final gate. `c2000_getVerificationResult` retrieves
the durable result by id.

Build verification selects an installation-time provider id. It may inspect a
complete log or invoke a trusted configured executable with fixed arguments;
the MCP request cannot submit shell text. Diagnostics are structured and the
complete log is retained. Build identity includes project, target,
configuration, CCS/compiler/ABI/device when known, optional source/git
identity, tool version, and times.

Map verification is a separate TI C2000 parser. It reports memory regions,
origin/length/page, used/free/utilization, section placement, `.stack` static
allocation, CLA/MSGRAM/IPC-related metrics when present, and configured hard
gates. A parse failure is BLOCKED/UNSUPPORTED, never PASS. Current map
metadata must match the current build path/hash/mtime/build identity; stale
artifacts are rejected. Map metrics use the existing deterministic metric and
baseline concepts rather than a second baseline format.

Regression runs a declared plan through allowlisted host/mock runners. Hardware
requires `requireHardware=true` and an explicit durable runner. Skipped,
blocked, unsupported, timeout, incomplete, and Mock results stay distinct.

Review is deterministic: diff text/path or changed files, path rules, bounded
patterns, line limits, companion files, and configured realtime/linker/
interface/IPC evidence requirements. It never calls Git as a requirement and
never calls an LLM. Missing evidence produces a structured block/review
requirement, not an invented PASS.

Final gating is not an average score: build/regression/map hard-gate/review
critical failures reject; incomplete artifacts and required unsupported
verifiers block. Explicitly disabled stages are recorded as skipped.

# Changelog

## Unreleased

### MCP transport startup resilience

- Add a supervised MCP stdio entrypoint that retries child startup failures,
  replays the initialize handshake after an early restart, coalesces concurrent
  daemon startups, and preserves live daemon metadata across transient health
  check failures.
- Make offline acceptance follow the version-slot runtime recorded in
  `current.json`, keeping the release verification path aligned with atomic
  side-by-side installs.

### Read-only resident-image verification

- Add `c2000_verifyResidentImage`: under the current board lease it can attach
  disconnected cores and read a manifest-bound firmware identity marker through
  raw memory without programming Flash, loading symbols, resetting, running, or
  writing target memory. The daemon re-hashes the `.out` and manifest before
  promoting the requested cores from `UNKNOWN` to `KNOWN`; mismatches remain
  failed verification evidence.

### F28P65x dual-core Flash programming contract

- Add the `f28p65x-paired-flash` startup preset: both Flash images are
  programmed while every application core stays halted, and application startup
  begins only after the Flash programming boundary closes. The historical
  `hybrid30k-dk9-owner-first` preset remains available for CPU2 **RAM** images
  but is no longer usable for a CPU2 Flash image.
- Reject `loadSequence.mode=cpu1-run-before-cpu2` for a CPU2 Flash image before
  the first target access (`StartupContractInvalid` with
  `diagnosisCode=PAIRED_FLASH_REQUIRES_HALTED_OWNER`).
- Budget `prepareFlashLoad` with a dedicated `flashPrepareMs` DSS deadline
  (default 120000 ms) instead of the 5000 ms state-read deadline. ConfigureClock
  and ConfigureBanks are Flash operations, so a preparation deadline no longer
  reports as a bank or transport failure: it surfaces as
  `FlashPreparationTimeout` with `stage=prepare-flash`, owner/target core ids,
  the bank list and the expired budget.
- Apply the process-wide DSS script deadline as the longest budget currently in
  flight and retire each command's budget on completion, so a short state poll on
  one core can no longer shorten a long Flash preparation on another.
- Route `prepareFlashLoad` through the owner core with an explicit
  `targetCoreId`. ConfigureClock/ConfigureBanks execute in the CPU1 Flash Plugin
  context (the owner's DSS channel and thread), and the target core is never
  inferred from whichever channel carried the command.
- Fail closed with `FlashOwnerCoreNotHalted` when the CPU1 Flash Plugin owner is
  not connected and halted before CPU2 Flash preparation, and with
  `FlashProgrammingWindowActive` when any core is started inside the paired Flash
  boundary. Neither layer halts the owner implicitly, so a workflow that starts
  an application core too early is reported instead of hidden.
- Quarantine the session when CPU2 Flash preparation times out, and classify the
  preparation deadline as `flash_operation_timeout` in Flash evidence.
- Report the applied boundary in `flashProgramming` (`performed`, `preset`,
  `contractSource`, `ownerCoreId`, `targetCoreId`, `flashBanks`,
  `ownerStateAfterCpu1Load`, `applicationCoresStartedDuringFlash`) on every IPC
  acceptance result and in first-failure evidence.
- Preserve the reset contract: `system`/`cpu` resets still go through
  `ResetType.issueReset` with `requestedResetType == effectiveResetType` and no
  silent fallback; regression coverage was extended to the paired Flash flow.
- Document the contract, error catalog and DK9 first-bring-up validation steps in
  `docs/f28p65x-paired-flash-contract.md`.

## 0.7.1 - 2026-09-16

- Add deterministic Build, TI C2000 Map, declared host/Mock Regression, and
  diff/contract Review verifiers with one versioned Verification Result
  contract, atomic evidence manifests, freshness checks, and a high-level
  Engineering Verification Suite.
- Add additive verification configuration and six host-side MCP tools while
  preserving the stdio proxy → daemon → worker, durable job, board lease,
  fencing, safety, allowed-root, and Mock-versus-hardware boundaries.
- Add versioned Skill evolution data, bounded candidate edits, strict
  validation/promotion gates, and a durable rejected-edit buffer without any
  automatic production Skill rewrite or model API dependency.
- Make `skills/c2000-multicore-debug/SKILL.md` canonical, generate the `.skills`
  mirror, add progressive-disclosure references, and package/install the
  independent `c2000-skill-improver` Skill.
- Harden CPU2 boot handoff workflows by disconnecting CPU2 while CPU1 performs
  the firmware-owned release, reconnecting it before readiness/diagnosis, and
  recording the release evidence in workflow results.
- Fail closed before target programming when a session would repeat a CPU2
  Flash load that can erase a resident image; use `c2000_loadSymbols` for
  resident code or explicitly opt in with `allowDestructiveFlashReload`.
- Extend the supported Node.js runtime contract to Node 24.x, upgrade
  `better-sqlite3` to the Node 24-compatible 12.x line, and publish the Node
  24 Windows ABI 137 package alongside the existing Node 20/22 packages.
- Add strict fenced durable steps for expression assignment, fault injection,
  bounded expression capture, expression waits, and explicit reset/reconnect/
  reload/capture safety recovery. Non-idempotent steps are never blindly
  retried or restart-replayed.
- Atomically export custom expression snapshots with a SHA-256 manifest entry,
  and close every job-owned debug session before releasing its board lease.
- Make durable multicore launch honor `loadPrograms: false`, forward and apply
  the explicit CPU1-before-CPU2 `loadSequence`, and avoid resurrecting worker-
  cleaned failed sessions as `OPEN` daemon records.
- Preserve manifest-referenced snapshots across post-commit artifact-index
  failures, retry structured cleanup failures before lease release, and
  quarantine boards whose session ownership cannot be safely closed.
- Add a legacy persisted-v1 recovery migration without weakening strict new
  target-control steps, plus cardinality, string, expanded-evidence, and
  runtime output-size limits for durable plans.
- Add Round 8 F28P65x hardware-acceptance result/event/manifest schemas and
  atomic `HARDWARE_ACCEPTANCE_REPORT.md` generation.
- Add fail-closed general, PCAN, two-board, and supported-Node runtime gates
  before CCS/DSS/XDS110/PCAN access.
- Add standardized `acceptance:hardware:*` entry points with explicit
  evidence classifications and no Mock-to-hardware promotion.
- Move the `acceptance:ready` and `acceptance:ccs:mcp` opt-in gate before
  their build step.
- Add the pure-Python `c2000-hil` SDK and pytest fixture. The SDK speaks only
  authenticated daemon RPC, acquires/releases boards through explicit debug
  sessions, and never opens DSS, XDS110, SQLite, or PCAN directly.
- Add deterministic run metrics (`metrics.json`) with raw-source linkage,
  linear-R7 percentiles, population standard deviation, invalid/miss/overflow
  counters, and DLOG RMS derivation.
- Add `c2000_createRunBaseline` and `c2000_compareRunWithBaseline` with
  firmware, device, board-profile, test-plan, metric-schema, tool-version, and
  evidence-level identity binding. Incompatible comparisons fail closed unless
  the caller explicitly records an override.
- Package the Python SDK with the npm runtime, add an offline-safe Python
  packaging smoke check, and keep CycloneDX SBOM/SHA-256 generation in the
  release workflow.
- Fail fast on unsupported Node patch/minor versions and invalid private GitHub
  authentication before downloading release assets; verify downloaded archives
  against published SHA-256 metadata and clean temporary files.
- Add a Windows isolated source installer that reuses healthy dependencies,
  builds outside the repository `dist` directory to avoid live MCP file locks,
  installs through the bundled setup entrypoint, and always removes staging
  files.
- Add `c2000_registerBoard` for validated, persisted XDS110 registration and
  isolated worker startup without manual daemon config editing.
- Route safe/action launch wrappers through the same daemon worker and lease
  boundary as the base launch workflow.
- Preserve workflow handler context through the generic tool invoker.
- Replace the proxy's fixed five-second daemon response timeout with the
  configurable `C2000_MCP_REQUEST_TIMEOUT_MS` long-operation timeout.
- Enforce one daemon process per runtime directory and let proxies rediscover
  once after a stale endpoint or authentication token.
- Add fail-fast board-registration remediation, core ID conventions, and
  filesystem-root guidance to machine-readable tool surface metadata.
- Raise the worker command floor to 60 seconds and derive long workflow
  envelopes and lease TTLs from nested CCS startup, reset, connect, and
  program-load budgets.
- Add an explicit `cpu1-run-before-cpu2` IPC load sequence for RAM builds that
  require CPU1 ownership initialization before loading the CPU2 image.
- Clarify that `corePattern` should be an exact CCS target selector such as
  `C28xx_CPU1` or `C28xx_CPU2`, not a regular expression.
- Add `c2000_loadSymbols`, a symbol-only Flash debugging path backed by DSS
  `DebugSession.symbol.load` that does not erase, program, or write target
  memory and does not claim the image was loaded through this MCP.
- Make durable IPC jobs create one connect-only session, then perform the
  requested load policy and CPU1/CPU2 load sequence exactly once.
- Gate daemon-hosted acceptance readiness on an enumerated, registered,
  READY/unleased board, a healthy worker, and available board concurrency.
- Rename registry-only verification to `verify-mcp-registry`; retain
  `verify-only` as a deprecated alias and explicitly report that target Flash
  was not verified. Honor the policy consistently in single-core, batch, and
  reload workflow program loads.
- Skip disabled-core program/map path checks when `load: false`.
- Add an optional controlled post-load reset and CPU1-first boot stage to
  `c2000_runReloadAndDiagnose` without writing PC.
- Batch `c2000_waitForExpressionSet` reads per core and report poll iterations,
  expression batch calls, expression count, and measured poll duration.
- Resolve the real installer entrypoint before locating the packaged runtime,
  so `npm exec` works through its generated `.bin` symlink.
- Support npm-hoisted `better-sqlite3` layouts when adapting a Node 22 release
  bundle to another supported Node ABI.
- Let the macOS bootstrap automatically reuse a compatible Homebrew Node.js
  installation when the system-default Node release is unsupported.
- Exercise the packaged installer through its public `.bin` command during
  release verification.

## 0.6.1

- Add short authenticated one-command bootstrap scripts for Windows and macOS
  private-repository installations.
- Detect the host architecture and require a supported Node.js LTS release
  before downloading the platform-specific runtime.

## 0.6.0

- Add `c2000-multicore-setup`, a durable one-command installer for Windows and
  macOS that validates the platform runtime, installs the bundled Codex skill,
  registers the MCP server, and runs the installed-runtime doctor.
- Publish platform-specific Windows x64, macOS arm64, and macOS x64 release
  archives with package-install verification, checksums, and SBOMs.

## 0.5.0

- Added firmware-driven CAN evidence with explicit TX, independent bus capture, peer RX, application processing, and simulation-only evidence levels.
- Added passive PCAN capture statistics and corrected delivery progression; successful `CAN_Write` now means `QUEUED_TO_ADAPTER`, never delivered.
- Added evidence-driven firmware CAN readiness, atomic two-board leases, fair prioritized board scheduling, retry attempts, `step.on`, and abort-aware cancellation.
- Isolated PCAN/Koffi in `c2000-can-worker` and added persistent channel fencing leases.
- Added DSS process identity evidence, strict stale-process ownership decisions, and fresh-session read-only hardware reconciliation.
- Split Fast, Deep, and Packaging CI; added platform release artifacts, runtime manifests, SHA-256 metadata, and SBOM generation.

Hardware note: this release has automated Mock/Fake Driver coverage. Real XDS110 + two-board + PCAN hardware acceptance is not claimed unless the manual hardware workflow is run on the configured rig.

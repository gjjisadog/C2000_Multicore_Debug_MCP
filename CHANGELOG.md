# Changelog

## Unreleased

- Add strict fenced durable steps for expression assignment, fault injection,
  bounded expression capture, expression waits, and explicit reset/reconnect/
  reload/capture safety recovery. Non-idempotent steps are never blindly
  retried or restart-replayed.
- Atomically export custom expression snapshots with a SHA-256 manifest entry,
  and close every job-owned debug session before releasing its board lease.
- Make durable multicore launch honor `loadPrograms: false`, forward and apply
  the explicit CPU1-before-CPU2 `loadSequence`, and avoid resurrecting worker-
  cleaned failed sessions as `OPEN` daemon records.
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
- Align the supported runtime contract and documentation with tested Node
  20.19+ and Node 22.12+ releases; recommend Node 22 and stop advertising Node
  24 while the Windows native dependency bundle requires an unavailable
  prebuilt binding or an extra ClangCL toolchain.
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

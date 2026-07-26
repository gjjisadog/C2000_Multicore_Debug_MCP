# Changelog

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

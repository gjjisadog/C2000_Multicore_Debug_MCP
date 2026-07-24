# Changelog

## 0.5.0

- Added firmware-driven CAN evidence with explicit TX, independent bus capture, peer RX, application processing, and simulation-only evidence levels.
- Added passive PCAN capture statistics and corrected delivery progression; successful `CAN_Write` now means `QUEUED_TO_ADAPTER`, never delivered.
- Added evidence-driven firmware CAN readiness, atomic two-board leases, fair prioritized board scheduling, retry attempts, `step.on`, and abort-aware cancellation.
- Isolated PCAN/Koffi in `c2000-can-worker` and added persistent channel fencing leases.
- Added DSS process identity evidence, strict stale-process ownership decisions, and fresh-session read-only hardware reconciliation.
- Split Fast, Deep, and Packaging CI; added platform release artifacts, runtime manifests, SHA-256 metadata, and SBOM generation.

Hardware note: this release has automated Mock/Fake Driver coverage. Real XDS110 + two-board + PCAN hardware acceptance is not claimed unless the manual hardware workflow is run on the configured rig.

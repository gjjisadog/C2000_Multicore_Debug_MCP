# Artifacts and metrics

Verifier evidence is written through `AtomicArtifactWriter`, which writes a
temporary file, fsyncs and closes it, then atomically renames it. The manifest
is the final commit marker. Retain complete logs and failure evidence; a
summary response is not a substitute for the files.

Existing durable job artifacts remain canonical for target jobs. A host-only
verification uses `verificationId` and may reference `jobId`; it is not a new
target job. When a real job id exists, verification artifacts may be attached
to the existing artifact repository.

Metrics include source/evidence identity and deterministic values such as
`flash.used`, `ram.used`, region utilization, `cla.program.utilization`, and
`stack.static.bytes`. Static linker `.stack` allocation is not runtime stack
high-water usage. Baselines must remain bound to compatible firmware,
device/test-plan, metric schema, and evidence level.

Always report completeness and evidence classification. A missing log, map,
manifest, source, or stale artifact is a recorded incomplete/blocking fact,
not a successful empty result.

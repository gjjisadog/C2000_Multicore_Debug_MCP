# Authorized System Reset before firmware-owned CPU2 handoff

This is an opt-in diagnostic experiment, not a firmware fix or a cold-start
acceptance result. Default IPC and reload workflows are unchanged. A system or
default `postLoadResetType` after CPU2 disconnect is still rejected.

For an externally isolated F28P65x board, obtain explicit approval for resetting
peripheral/GPIO/protection state and verifying firmware's subsequent Safe-Off
initialization. This does not authorize PWM arm, protection clearing commands,
Gate/Driver/Relay enable, or security/OTP writes.

Use one durable job with the registered serial-bound board and one current lease:

1. Load the exact CPU1/CPU2 image pair with declared output and map hashes.
2. Run a `runIpcAcceptance` step with explicit `runMode: "cpu1_boots_cpu2"`,
   `loadSequence.mode: "cpu1-then-cpu2"`, `programPreparation: "symbols-only"`,
   and `loadPolicy: "verify-mcp-registry"`. Omit `postLoadResetType`.
3. Supply plan safety guards covering both cores and
   `systemResetBeforeHandoff: { authorized: true, postStartupConditions: [...] }`.
   Additional conditions must be read-only symbol/member or constant-address
   reads with firmware/board-specific expected values. They do not replace the
   original guards or IPC readiness conditions.
4. The workflow verifies both current-session image records, suppresses both
   GEL callback sets, requires both cores connected/halted, then issues one
   explicit CPU1 System Reset before CPU2 disconnect. No later CPU reset occurs.
5. It runs CPU1 only, verifies application entry, and reconnects CPU2 after the
   declared settle time. Before IPC polling, it rechecks the original safety
   guards plus the additional conditions. Any mismatch/unreadable value causes
   a fenced halt and failure, with the reset evidence retained. CPU2 is never run
   independently to manufacture a ready verdict.

Keep `retryPolicy` empty and use always-on halt/cleanup steps. Runtime contracts
are durable-plan 5 / IPC 9; activate matching frontend, daemon and worker builds
before submission. Old runtimes must not silently ignore the new field.

Record `postLoadReset.phase=before-cpu2-disconnect`, both pre-reset core states,
the reset mechanism/effective type, and pre/post safety results. Reset evidence
explicitly reports `physicalColdStartVerified=false`. Register/watch checks do
not prove physical output voltage or response latency; those remain separate
hardware gates. Do not report Host/Mock ordering tests as hardware acceptance.

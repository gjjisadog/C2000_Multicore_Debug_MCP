# Debugging reference

Before CCS or target access, call `c2000_getEnvironment`,
`c2000_getServerHealth`, `c2000_getDaemonHealth`, and `c2000_listBoards` as
applicable. Use only valid, configured paths. An empty or unready board list is
a registration/readiness problem; do not try a different launch tool or direct
DSS.

Prefer one workflow call: IPC acceptance uses
`c2000_launchAndRunIpcAcceptance` or `c2000_runIpcAcceptance`; boot handoff
uses `c2000_runBootHandoffDiagnosis`; reload diagnosis uses
`c2000_runReloadAndDiagnose`; a complete evidence capture uses
`c2000_runFullDebugBundle`.

Keep an interactive session alive only when follow-up calls are necessary. For
long or multi-board work submit one durable plan and poll `c2000_getTestRun`
until terminal. Do not retry a timeout blindly: a target operation may have
started.

CPU2 RAM loading may require the declared `cpu1-run-before-cpu2` sequence.
CPU1-owned boot handoff uses `runSequence.runMode=cpu1_boots_cpu2`; keep both
inside the server workflow. Treat a changed PC or Halted state alone as
insufficient reset evidence.

When a symbol is missing, preserve the exact core, stage, and target-access
status. A known PC with no source mapping is not a successful symbol resolve.

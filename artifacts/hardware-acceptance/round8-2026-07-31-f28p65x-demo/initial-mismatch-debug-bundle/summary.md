# c2000_runIpcAcceptance Debug Bundle

- sessionId: dbg-add9dc2c-de41-44b9-b59a-27fe2cb2bf2f
- device: F28P65x
- success: false
- diagnosisCode: IPC_READY_TIMEOUT
- severity: error
- orchestration: server-internal
- mcpToolCalls: []
- verdictReady: false
- runtimeRamOwnershipMatched: true

## IPC conditions

- cpu1-stage-running: n/a (expected 5, matched=false)
- cpu1-cpu2-ready: n/a (expected 1, matched=false)
- cpu1-boot-error-clear: n/a (expected 0, matched=false)
- cpu2-stage-running: n/a (expected 5, matched=false)
- cpu2-initial-param-applied: n/a (expected 1, matched=false)

## Loaded programs

- CPU1: C:\Users\11981\Documents\C2000_Debug_MCP\.hardware-demo-workspace-ipc-ex1\ipc_ex1_basic_c28x1\CPU1_RAM\ipc_ex1_basic_c28x1.out sha256=f649cc246084fbcc1b453cc54d47f6adee7ab4a7a7b76de6595155dcc261a38d fresh=true
- CPU2: C:\Users\11981\Documents\C2000_Debug_MCP\.hardware-demo-workspace-ipc-ex1\ipc_ex1_basic_c28x2\CPU2_RAM\ipc_ex1_basic_c28x2.out sha256=3ea0ac74fb40d9172193bdcdf5a5a54cd9c99d3a4d4973c5278d41f92613c8a8 fresh=true

## PC evidence

- core 0: 0xC5FC main+0x59 [RAMD0]
- core 2: 0x183C9 main+0x1A [RAMGS4]

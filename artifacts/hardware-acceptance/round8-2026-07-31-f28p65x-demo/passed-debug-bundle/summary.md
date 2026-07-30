# c2000_runIpcAcceptance Debug Bundle

- sessionId: dbg-a493f20a-40f8-498a-8ed4-ac2454077819
- device: F28P65x
- success: true
- diagnosisCode: IPC_ACCEPTANCE_READY
- severity: info
- orchestration: server-internal
- mcpToolCalls: []
- verdictReady: true
- runtimeRamOwnershipMatched: true

## IPC conditions

- ti-ipc-demo-pass: 1 (expected 1, matched=true)

## Loaded programs

- CPU1: C:\Users\11981\Documents\C2000_Debug_MCP\.hardware-demo-workspace-ipc-ex1\ipc_ex1_basic_c28x1\CPU1_RAM\ipc_ex1_basic_c28x1.out sha256=f649cc246084fbcc1b453cc54d47f6adee7ab4a7a7b76de6595155dcc261a38d fresh=true
- CPU2: C:\Users\11981\Documents\C2000_Debug_MCP\.hardware-demo-workspace-ipc-ex1\ipc_ex1_basic_c28x2\CPU2_RAM\ipc_ex1_basic_c28x2.out sha256=3ea0ac74fb40d9172193bdcdf5a5a54cd9c99d3a4d4973c5278d41f92613c8a8 fresh=true

## PC evidence

- core 0: 0xC5FC main+0x59 [RAMD0]
- core 2: 0x183C9 main+0x1A [RAMGS4]

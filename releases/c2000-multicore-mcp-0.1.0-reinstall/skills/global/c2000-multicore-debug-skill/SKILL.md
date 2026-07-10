---
name: c2000-multicore-debug-skill
description: Use only when the user explicitly names `c2000-multicore-debug-skill` or explicitly requests a `c2000_` debug workflow through c2000-multicore-mcp.
---

# C2000 Multicore Debug

Use the user's self-developed `c2000-multicore-mcp` only for explicit F28P65x target operations. Do not activate this skill for general C2000, CPU1/CPU2, CCS, IPC, or RAMGS discussion.

## Required Rules

- Route dual-core debug control through explicit `sessionId` and `coreId`; `0` is CPU1 and `2` is CPU2.
- Do not use TI official MCP debug control tools, CCS active target, or CCS UI focus for CPU1/CPU2 automation.
- When no session exists, prefer `c2000_launchAndRunIpcAcceptance`; it creates/connects the session and runs IPC acceptance in one client-visible call. With an existing connected session, prefer `c2000_runIpcAcceptance`, `c2000_runBootHandoffDiagnosis`, `c2000_runReloadAndDiagnose`, or `c2000_runFullDebugBundle`.
- Use atomic tools only for a user-requested single action or workflow failure evidence; explain that each may require MCP approval.
- If the self-developed MCP server or a needed capability is unavailable, report that fact instead of substituting TI official MCP debug controls.

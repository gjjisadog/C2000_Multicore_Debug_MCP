# C2000 Multicore MCP Reinstall Bundle

## Contents

- `mcp/c2000-multicore-mcp-0.1.0.tgz`: installable Node.js MCP package.
- `skills/global/c2000-multicore-debug-skill/`: explicit-trigger global Codex skill.
- `skills/project/c2000-multicore-debug/`: project-scoped Codex skill.

## Reinstall

1. Install the MCP package with `npm install -g ./mcp/c2000-multicore-mcp-0.1.0.tgz`.
2. Copy `skills/global/c2000-multicore-debug-skill/` to `~/.codex/skills/`.
3. Copy `skills/project/c2000-multicore-debug/` to the target project's `.skills/` directory when project-scoped guidance is needed.
4. Configure or refresh the Codex MCP server entry to invoke `c2000-multicore-mcp`.
5. Restart Codex so its MCP tool list and skill catalog are rebuilt.

The global skill triggers only when explicitly named or when a `c2000_` workflow call is explicitly requested. For a target without an existing debug session, use `c2000_launchAndRunIpcAcceptance`.

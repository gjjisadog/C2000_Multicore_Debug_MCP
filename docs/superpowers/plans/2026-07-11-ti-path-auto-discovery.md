# TI Path Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve CCS, C2000Ware, and F28P65x target configuration paths without hard-coded installation locations, and expose the resolved environment to AI clients through one read-only MCP tool.

**Architecture:** Add a focused host-side resolver that applies explicit configuration first, then scans supported macOS/Linux/Windows roots, validates product anchor files, and reports both selected and rejected candidates. Configuration loading, readiness scripts, and the MCP environment tool consume the same resolver so they cannot drift.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, MCP SDK, Vitest.

---

### Task 1: Path resolver

**Files:**
- Create: `src/config/tiPaths.ts`
- Create: `tests/tiPaths.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Cover explicit-path priority, discovery under a supplied home directory, semantic version selection, anchor validation, C2000Ware `.metadata/sdk.json` parsing, `.ccxml` discovery, and rejected-candidate reporting.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/tiPaths.test.ts`

Expected: FAIL because `src/config/tiPaths.ts` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

Expose:

```ts
export async function resolveTiEnvironment(options?: ResolveTiEnvironmentOptions): Promise<TiEnvironmentResolution>
```

Use precedence `explicit input > environment/config value > validated discovery`. Validate CCS with `ccs_base/DebugServer/bin/DSLite`, validate C2000Ware with `.metadata/sdk.json`, and resolve the F28P65x `.ccxml` below the selected C2000Ware root.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/tiPaths.test.ts`

Expected: PASS.

### Task 2: Configuration and readiness integration

**Files:**
- Modify: `src/config/config.loader.ts`
- Modify: `src/config/config.schema.ts`
- Modify: `scripts/ccs-acceptance-readiness.ts`
- Test: `tests/configLoader.test.ts`

- [ ] **Step 1: Write failing integration tests**

Assert that missing CCS fields are populated from the resolver, explicit file/env values win, and no `/Applications/ti/...` default is required.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/configLoader.test.ts`

Expected: FAIL because configuration loading does not invoke discovery.

- [ ] **Step 3: Integrate the resolver**

Resolve absent `ccs.installPath` and `ccs.ccxmlPath` during `loadConfig()`. Update readiness to resolve the environment once and pass canonical paths into both the child MCP environment and readiness arguments.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/configLoader.test.ts`

Expected: PASS.

### Task 3: Read-only MCP environment tool

**Files:**
- Modify: `src/mcp/toolSchemas.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/toolHandlers.ts`
- Test: `tests/toolHandlers.test.ts`
- Test: `tests/toolSafety.test.ts`

- [ ] **Step 1: Write failing tool tests**

Assert that `c2000_getEnvironment` is registered in every profile, is annotated read-only, returns selected paths, versions, sources, validation evidence, and rejected candidates, and never touches the target.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/toolHandlers.test.ts tests/toolSafety.test.ts`

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Implement the tool**

Add an empty-input schema and handler that calls the shared resolver. Register it as `inputScope: "host"`, `targetEffect: "host-read"`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/toolHandlers.test.ts tests/toolSafety.test.ts`

Expected: PASS.

### Task 4: AI guidance and full verification

**Files:**
- Modify: `.skills/c2000-multicore-debug/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Document the discovery contract**

Require AI clients to call `c2000_getEnvironment` before readiness/debug workflows and prohibit guessed TI paths. Document override precedence and supported discovery roots.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run build
npm test
npm run verify:debug-boundary
npm run smoke:mcp
```

Expected: all commands exit `0`.

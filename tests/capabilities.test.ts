import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import {
  CAPABILITY_DESCRIPTORS,
  CapabilitySessionManager,
  TOOL_CAPABILITY_NAMES,
  type CapabilityAuditEvent,
  type ToolCapability
} from "../src/mcp/capabilities.js";
import {
  c2000ToolDefinitions,
  definitionsForDynamicExposure,
  registerC2000Tools
} from "../src/mcp/tools.js";

type RequestHandler = (request: any, extra: any) => Promise<any>;

interface Harness {
  server: McpServer;
  manager: DebugSessionManager;
  registration: ReturnType<typeof registerC2000Tools>;
  clock: { now: number };
}

function createHarness(profile: "readonly" | "safe" | "full" = "safe", surface: "agent" | "advanced" | "compatibility" = "agent"): Harness {
  const server = new McpServer({ name: "c2000-capability-test", version: "test" });
  const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
  const clock = { now: Date.parse("2026-09-01T00:00:00.000Z") };
  const capabilitySessions = new CapabilitySessionManager({ now: () => clock.now });
  type ExposureSummary = ReturnType<ReturnType<typeof registerC2000Tools>["getExposureSummary"]>;
  let getExposureSummary: (() => ExposureSummary) | undefined;
  const registration = registerC2000Tools(
    server,
    manager,
    {
      getServerHealth: () => {
        const exposure = getExposureSummary?.();
        return {
          status: "ready",
          configuration: {
            capabilityMode: "dynamic",
            activeCapabilityCount: exposure?.activeCapabilities.length ?? 0
          },
          tools: {
            registeredCount: exposure?.registered.length ?? 0,
            activeCapabilityCount: exposure?.activeCapabilities.length ?? 0
          }
        };
      }
    },
    profile,
    { allowedReadRoots: [process.cwd()], allowedWriteRoots: [] },
    {},
    {},
    surface,
    { capabilitySessions }
  );
  getExposureSummary = registration.getExposureSummary;
  return { server, manager, registration, clock };
}

async function disposeHarness(harness: Harness): Promise<void> {
  harness.registration.dispose();
  await harness.manager.disposeAllSessions();
  await harness.server.close();
}

function requestHandler(server: McpServer, method: "tools/list" | "tools/call"): RequestHandler {
  const handlers = (server.server as unknown as {
    _requestHandlers: Map<string, RequestHandler>;
  })._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Missing MCP request handler: ${method}`);
  return handler;
}

async function listTools(server: McpServer): Promise<any> {
  return requestHandler(server, "tools/list")({ method: "tools/list", params: {} }, {});
}

async function callTool(server: McpServer, name: string, arguments_: Record<string, unknown> = {}): Promise<any> {
  return requestHandler(server, "tools/call")({
    method: "tools/call",
    params: { name, arguments: arguments_ }
  }, {});
}

function listedNames(listed: { tools: Array<{ name: string }> }): Set<string> {
  return new Set(listed.tools.map(tool => tool.name));
}

describe("C2000 task-aware capability exposure", () => {
  test("defines a small capability vocabulary and a single membership source", () => {
    expect(TOOL_CAPABILITY_NAMES).toHaveLength(8);
    expect(CAPABILITY_DESCRIPTORS.map(descriptor => descriptor.name)).toEqual([...TOOL_CAPABILITY_NAMES]);

    const expectedMembership: Record<ToolCapability, string[]> = {
      "debug.manual": [
        "c2000_createDebugSession",
        "c2000_listCores",
        "c2000_closeDebugSession",
        "c2000_connectTarget",
        "c2000_disconnectTarget",
        "c2000_runCore",
        "c2000_haltCore",
        "c2000_reset",
        "c2000_getTargetState",
        "c2000_connectCores",
        "c2000_haltCores",
        "c2000_resetCores",
        "c2000_runCores",
        "c2000_getLoadedProgramInfo",
        "c2000_resolvePc",
        "c2000_resolveAddress"
      ],
      "debug.program": ["c2000_loadProgram", "c2000_loadSymbols", "c2000_loadPrograms"],
      "debug.wait": ["c2000_waitUntilExpression", "c2000_waitForExpressionSet", "c2000_waitForIpcReady"],
      "observability.variables": [
        "c2000_startVariableStream",
        "c2000_stopVariableStream",
        "c2000_getVariableStreamStatus",
        "c2000_readVariableSamples",
        "c2000_exportVariableStream"
      ],
      "observability.dlog": [
        "c2000_describeDlogBuffer",
        "c2000_getDlogStatus",
        "c2000_readDlogBuffer",
        "c2000_exportDlog"
      ],
      "observability.erad": [
        "c2000_getEradCapabilities",
        "c2000_configureEradProfile",
        "c2000_startEradProfile",
        "c2000_stopEradProfile",
        "c2000_readEradProfile",
        "c2000_exportEradProfile"
      ],
      "observability.metrics": ["c2000_createAcceptanceClosure", "c2000_createRunBaseline", "c2000_compareRunWithBaseline"],
      "can.advanced": ["c2000_getBoardGroupSnapshot", "c2000_listCanProfiles", "c2000_submitCanFaultCampaign", "c2000_submitCanSoakTest"]
    };

    for (const capability of TOOL_CAPABILITY_NAMES) {
      expect(c2000ToolDefinitions.filter(tool => tool.capability === capability).map(tool => tool.name)).toEqual(expectedMembership[capability]);
    }
    expect(c2000ToolDefinitions.every(tool => tool.exposure !== undefined)).toBe(true);
    expect(c2000ToolDefinitions.some(tool => tool.name === "c2000_continue" && tool.capability !== undefined)).toBe(false);
  });

  test("CapabilitySessionManager is temporary, reason-bound, idempotent, and auditable", () => {
    const clock = { now: Date.parse("2026-09-01T00:00:00.000Z") };
    const audit: CapabilityAuditEvent[] = [];
    const sessions = new CapabilitySessionManager({ now: () => clock.now, onAudit: event => audit.push(event) });

    const opened = sessions.open("debug.manual", "Need one manual CPU1 halt check", 10, "test-agent");
    expect(opened.created).toBe(true);
    expect(opened.session).toEqual(expect.objectContaining({
      capability: "debug.manual",
      reason: "Need one manual CPU1 halt check",
      requestedBy: "test-agent",
      active: true,
      expiresAt: "2026-09-01T00:00:10.000Z"
    }));

    const duplicate = sessions.open("debug.manual", "A different reason must not replace the active grant", 20);
    expect(duplicate.created).toBe(false);
    expect(duplicate.session.id).toBe(opened.session.id);
    expect(duplicate.session.reason).toBe(opened.session.reason);

    clock.now = Date.parse(opened.session.expiresAt) + 1;
    expect(sessions.purgeExpired()).toEqual([expect.objectContaining({
      id: opened.session.id,
      active: false
    })]);
    expect(sessions.activeCapabilities()).toEqual([]);
    expect(audit.map(event => event.action)).toEqual(["open", "expire"]);
    expect(audit.every(event => event.reason.length > 0 && event.actor === "test-agent")).toBe(true);
    sessions.dispose();
  });

  test("default agent exposes controls, but opens only the requested debug.manual group", async () => {
    const harness = createHarness();
    try {
      const base = listedNames(await listTools(harness.server));
      expect(base).toContain("c2000_listCapabilities");
      expect(base).toContain("c2000_openCapabilitySession");
      expect(base).toContain("c2000_closeCapabilitySession");
      expect(base).not.toContain("c2000_runCore");
      expect(base).not.toContain("c2000_loadProgram");
      expect(base).not.toContain("c2000_describeDlogBuffer");

      const hiddenCall = await callTool(harness.server, "c2000_runCore", { sessionId: "not-used", coreId: 0 });
      expect(hiddenCall.structuredContent).toEqual(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "CapabilityRequired",
          details: expect.objectContaining({ requiredCapability: "debug.manual", tool: "c2000_runCore" })
        })
      }));

      const opened = await callTool(harness.server, "c2000_openCapabilitySession", {
        capability: "debug.manual",
        reason: "Inspect one stalled core without enabling program or observability tools"
      });
      expect(opened.structuredContent).toEqual(expect.objectContaining({
        success: true,
        capability: "debug.manual",
        created: true,
        visibleTools: expect.arrayContaining(["c2000_connectTarget", "c2000_runCore", "c2000_haltCore", "c2000_reset"]),
        blockedBySafety: [],
        toolsListChanged: true
      }));

      const after = listedNames(await listTools(harness.server));
      for (const name of ["c2000_connectTarget", "c2000_runCore", "c2000_haltCore", "c2000_reset", "c2000_getTargetState"]) {
        expect(after, name).toContain(name);
      }
      for (const name of ["c2000_loadProgram", "c2000_loadSymbols", "c2000_describeDlogBuffer", "c2000_startVariableStream", "c2000_configureEradProfile"]) {
        expect(after, name).not.toContain(name);
      }

      const contracts = await callTool(harness.server, "c2000_getToolContracts");
      expect(contracts.structuredContent).toEqual(expect.objectContaining({
        activeCapabilities: ["debug.manual"],
        capabilityVisibleToolCount: expect.any(Number),
        registeredToolCount: after.size,
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "c2000_runCore", capability: "debug.manual", surfaceVisible: true })
        ])
      }));

      const health = await callTool(harness.server, "c2000_getServerHealth");
      expect(health.structuredContent).toEqual(expect.objectContaining({
        configuration: expect.objectContaining({ capabilityMode: "dynamic", activeCapabilityCount: 1 }),
        tools: expect.objectContaining({ registeredCount: after.size, activeCapabilityCount: 1 })
      }));
    } finally {
      await disposeHarness(harness);
    }
  });

  test("observability capabilities are isolated and can be combined without broad escalation", async () => {
    const dlogHarness = createHarness();
    try {
      const opened = await callTool(dlogHarness.server, "c2000_openCapabilitySession", {
        capability: "observability.dlog",
        reason: "Read the existing target-side DLOG capture"
      });
      expect(opened.structuredContent).toEqual(expect.objectContaining({ success: true, capability: "observability.dlog" }));
      const names = listedNames(await listTools(dlogHarness.server));
      for (const name of ["c2000_describeDlogBuffer", "c2000_getDlogStatus", "c2000_readDlogBuffer", "c2000_exportDlog"]) {
        expect(names, name).toContain(name);
      }
      for (const name of ["c2000_startVariableStream", "c2000_getEradCapabilities", "c2000_runCore"]) {
        expect(names, name).not.toContain(name);
      }
    } finally {
      await disposeHarness(dlogHarness);
    }

    const combined = createHarness();
    try {
      await callTool(combined.server, "c2000_openCapabilitySession", {
        capability: "observability.variables",
        reason: "Monitor bounded low-rate variables during the failing IPC run"
      });
      await callTool(combined.server, "c2000_openCapabilitySession", {
        capability: "observability.dlog",
        reason: "Correlate the existing DLOG capture with variable samples"
      });
      const names = listedNames(await listTools(combined.server));
      expect(names).toContain("c2000_startVariableStream");
      expect(names).toContain("c2000_readDlogBuffer");
      expect(names).not.toContain("c2000_runCore");
      expect(names).not.toContain("c2000_getEradCapabilities");
    } finally {
      await disposeHarness(combined);
    }
  });

  test("TTL expiry removes tools and rejects a cached call before target dispatch", async () => {
    const harness = createHarness();
    try {
      const opened = await callTool(harness.server, "c2000_openCapabilitySession", {
        capability: "debug.manual",
        reason: "Perform a bounded manual state check",
        ttlSeconds: 1
      });
      const session = opened.structuredContent.session;
      expect(listedNames(await listTools(harness.server))).toContain("c2000_runCore");

      harness.clock.now = Date.parse(session.expiresAt) + 1;
      expect(listedNames(await listTools(harness.server))).not.toContain("c2000_runCore");

      const cachedCall = await callTool(harness.server, "c2000_runCore", { sessionId: "cached-session", coreId: 0 });
      expect(cachedCall).toEqual(expect.objectContaining({ isError: true }));
      expect(cachedCall.structuredContent).toEqual(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "CapabilityExpired",
          details: expect.objectContaining({
            tool: "c2000_runCore",
            requiredCapability: "debug.manual",
            activeSurface: "agent",
            activeToolProfile: "safe"
          })
        })
      }));
    } finally {
      await disposeHarness(harness);
    }
  });

  test("Safety remains authoritative when a capability is requested", async () => {
    const readonly = createHarness("readonly", "agent");
    try {
      const blocked = await callTool(readonly.server, "c2000_openCapabilitySession", {
        capability: "debug.program",
        reason: "Try to load symbols while running a read-only audit"
      });
      expect(blocked).toEqual(expect.objectContaining({ isError: true }));
      expect(blocked.structuredContent).toEqual(expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          code: "CapabilityNotAllowedBySafetyProfile",
          details: expect.objectContaining({
            capability: "debug.program",
            activeToolProfile: "readonly",
            visibleTools: []
          })
        })
      }));
      const names = listedNames(await listTools(readonly.server));
      expect(names).not.toContain("c2000_loadProgram");
      expect(names).not.toContain("c2000_loadSymbols");
    } finally {
      await disposeHarness(readonly);
    }

    const safe = createHarness("safe", "agent");
    try {
      const opened = await callTool(safe.server, "c2000_openCapabilitySession", {
        capability: "observability.erad",
        reason: "Inspect ERAD counters without allowing register mutation under safe policy"
      });
      expect(opened.structuredContent).toEqual(expect.objectContaining({
        success: true,
        capability: "observability.erad",
        blockedBySafety: expect.arrayContaining(["c2000_configureEradProfile", "c2000_startEradProfile", "c2000_stopEradProfile"])
      }));
      const names = listedNames(await listTools(safe.server));
      expect(names).toContain("c2000_getEradCapabilities");
      expect(names).toContain("c2000_readEradProfile");
      expect(names).not.toContain("c2000_configureEradProfile");
      expect(names).not.toContain("c2000_injectFaults");
    } finally {
      await disposeHarness(safe);
    }
  });

  test("advanced is implicitly capability-enabled while compatibility alone exposes aliases", async () => {
    const advanced = createHarness("safe", "advanced");
    try {
      const names = listedNames(await listTools(advanced.server));
      expect(names).toContain("c2000_runCore");
      expect(names).toContain("c2000_haltCore");
      expect(names).toContain("c2000_readDlogBuffer");
      expect(names).not.toContain("c2000_continue");
      expect(names).not.toContain("c2000_pause");

      const capabilities = await callTool(advanced.server, "c2000_listCapabilities");
      const erad = capabilities.structuredContent.available.find((entry: any) => entry.name === "observability.erad");
      expect(erad).toEqual(expect.objectContaining({ implicitlyVisible: true, active: false }));

      const open = await callTool(advanced.server, "c2000_openCapabilitySession", {
        capability: "debug.manual",
        reason: "Surface is already advanced; no temporary session is needed"
      });
      expect(open.structuredContent).toEqual(expect.objectContaining({
        success: true,
        implicitlyVisible: true,
        session: null,
        created: false
      }));
    } finally {
      await disposeHarness(advanced);
    }

    const compatibility = createHarness("safe", "compatibility");
    try {
      const names = listedNames(await listTools(compatibility.server));
      expect(names).toContain("c2000_runCore");
      expect(names).toContain("c2000_continue");
      expect(names).toContain("c2000_haltCore");
      expect(names).toContain("c2000_pause");
    } finally {
      await disposeHarness(compatibility);
    }
  });

  test("invalid, unknown, and missing capability session requests fail structurally", async () => {
    const sessions = new CapabilitySessionManager({ now: () => Date.now() });
    expect(() => sessions.open("not-a-capability", "test")).toThrow(/Unknown C2000 capability/);
    expect(() => sessions.open("debug.manual", "   ")).toThrow(/non-empty reason/);
    expect(() => sessions.open("debug.manual", "test", 0)).toThrow(/TTL/);
    expect(() => sessions.open("debug.manual", "test", 1801)).toThrow(/TTL/);
    expect(() => sessions.close("missing-session")).toThrow(/not found/);
    sessions.dispose();

    const harness = createHarness();
    try {
      const result = await callTool(harness.server, "c2000_openCapabilitySession", {
        capability: "not-a-capability",
        reason: "Verify structured unknown capability failure"
      });
      expect(result.structuredContent.error).toEqual(expect.objectContaining({ code: "CapabilityUnknown" }));
    } finally {
      await disposeHarness(harness);
    }
  });

  test("dynamic exposure remains a safety-first intersection", () => {
    const requested = TOOL_CAPABILITY_NAMES;
    const safeAgent = definitionsForDynamicExposure("safe", "agent", requested);
    const readonlyAgent = definitionsForDynamicExposure("readonly", "agent", requested);
    const fullAgent = definitionsForDynamicExposure("full", "agent", requested);

    expect(safeAgent.some(tool => tool.effects.includes("fault-injection"))).toBe(false);
    expect(safeAgent.some(tool => tool.effects.includes("target-memory-write"))).toBe(false);
    expect(readonlyAgent.some(tool => tool.effects.includes("target-reset"))).toBe(false);
    expect(readonlyAgent.some(tool => tool.effects.includes("program-load"))).toBe(false);
    expect(fullAgent.some(tool => tool.name === "c2000_continue")).toBe(false);
    expect(fullAgent.some(tool => tool.name === "c2000_pause")).toBe(false);
  });

  test("uses the MCP tools/list_changed notification for a connected client", async () => {
    const harness = createHarness();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let changedResolve: ((tools: any[]) => void) | undefined;
    const changed = new Promise<any[]>(resolve => { changedResolve = resolve; });
    const client = new Client(
      { name: "c2000-capability-client", version: "test" },
      { listChanged: { tools: { onChanged: (error, tools) => { if (!error) changedResolve?.(tools); } } } }
    );

    try {
      await harness.server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(harness.registration.dynamicToolListSupported).toBe(true);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);

      await client.callTool({
        name: "c2000_openCapabilitySession",
        arguments: { capability: "observability.dlog", reason: "Refresh the connected tool list for DLOG evidence" }
      });
      const refreshed = await Promise.race([
        changed,
        new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error("tools/list_changed was not delivered")), 1000))
      ]);
      expect(refreshed.map(tool => tool.name)).toContain("c2000_readDlogBuffer");
    } finally {
      await client.close().catch(() => undefined);
      await disposeHarness(harness);
    }
  });
});

import net from "node:net";
import { describe, expect, test, vi } from "vitest";
import { LocalRpcClient, LocalRpcServer } from "../src/rpc/RpcServer.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";
import { DebugMcpError } from "../src/utils/errors.js";
import { DaemonRpcServer } from "../src/daemon/DaemonRpcServer.js";
import type { OutcomeEvent } from "../src/analytics/OutcomeSchemas.js";

describe("local daemon RPC timeout", () => {
  test.each(["end", "partial", "reset"])("does not replay an executed operation after %s disconnect", async mode => {
    let executions = 0;
    const server = net.createServer(socket => {
      socket.once("data", () => {
        executions += 1;
        if (mode === "reset") socket.resetAndDestroy();
        else socket.end(mode === "partial" ? '{"type":"response"' : "");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const reconnect = vi.fn();
    const client = new McpDaemonClient(new LocalRpcClient({
      host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, authToken: "test", timeoutMs: 2000
    }), reconnect);
    try {
      await expect(client.invokeTool("c2000_runCore", { sessionId: "test-session", coreId: 0 })).rejects.toMatchObject({
        code: "DaemonRequestInterrupted", details: { requestSent: true }
      });
      expect(executions).toBe(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("partial response traffic cannot extend the request deadline", async () => {
    const server = net.createServer(socket => {
      const timer = setInterval(() => socket.write(" "), 10);
      socket.on("error", () => undefined);
      socket.once("close", () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const client = new LocalRpcClient({
      host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, authToken: "test", timeoutMs: 100
    });
    try {
      await expect(client.request("health", {})).rejects.toMatchObject({ code: "DaemonRequestTimeout" });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test.each(["DaemonUnavailable", "DaemonRequestTimeout", "DaemonProtocolError"] as const)(
    "does not retry %s without evidence that the request was not sent", async code => {
      const request = vi.fn().mockRejectedValue(new DebugMcpError(code, "result unknown"));
      const reconnect = vi.fn();
      const client = new McpDaemonClient({ request } as unknown as LocalRpcClient, reconnect);
      await expect(client.invokeTool("c2000_runCore", { sessionId: "test-session", coreId: 0 })).rejects.toMatchObject({ code });
      expect(request).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    }
  );

  test("reconnects after a refused connection before any request was sent", async () => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const request = vi.fn().mockResolvedValue({ result: { success: true } });
    const reconnect = vi.fn().mockResolvedValue({ request });
    const client = new McpDaemonClient(new LocalRpcClient({ host: "127.0.0.1", port, authToken: "test" }), reconnect);
    await expect(client.invokeTool("c2000_runCore", { sessionId: "test-session", coreId: 0 })).resolves.toEqual({ success: true });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("distinguishes a connected long-running request timeout and allows an override", async () => {
    const server = new LocalRpcServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
      handle: async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        return { ready: true };
      }
    });
    const endpoint = await server.listen();
    try {
      const client = new LocalRpcClient({ ...endpoint, authToken: "test-token", timeoutMs: 250 });
      await expect(client.request("health", {})).rejects.toEqual(expect.objectContaining({
        code: "DaemonRequestTimeout",
        message: expect.stringContaining("waiting for c2000-debugd response")
      }));
      await expect(client.request("health", {}, 1000)).resolves.toEqual({ ready: true });
    } finally {
      await server.close();
    }
  });

  test("rediscovers once after a stale daemon authentication failure", async () => {
    const stale = {
      request: async () => {
        throw new DebugMcpError("DaemonAuthenticationFailed", "stale token");
      }
    } as unknown as LocalRpcClient;
    const refreshed = {
      request: async () => ({
        result: { success: true, daemon: { instanceId: "new-instance" } }
      })
    } as unknown as LocalRpcClient;
    let reconnects = 0;
    const client = new McpDaemonClient(stale, async () => {
      reconnects += 1;
      return refreshed;
    });

    await expect(client.invokeTool("c2000_getDaemonHealth", {})).resolves.toEqual({
      success: true,
      daemon: { instanceId: "new-instance" }
    });
    expect(reconnects).toBe(1);
  });

  test("forwards sanitized capability outcome events through the authenticated daemon RPC", async () => {
    const received: OutcomeEvent[] = [];
    const server = new DaemonRpcServer({
      authToken: "analytics-token",
      port: 0,
      toolInvoker: { invokeTool: async () => ({ success: true }) },
      health: () => ({ ready: true }),
      recordOutcomeEvent: event => { received.push(event as OutcomeEvent); }
    });
    const endpoint = await server.listen();
    try {
      const client = new McpDaemonClient(new LocalRpcClient({ ...endpoint, authToken: "analytics-token" }));
      const event: OutcomeEvent = {
        eventId: crypto.randomUUID(),
        timestamp: "2026-09-01T00:00:00.000Z",
        kind: "capability_open",
        name: "observability.dlog",
        outcome: "success",
        toolProfile: "safe",
        toolSurfaceProfile: "agent",
        activeCapabilities: ["observability.dlog"],
        sessionId: "cap-1",
        escalationTo: "observability.dlog",
        metadata: { openedFrom: { failureClass: "dlog" } }
      };
      await client.recordOutcomeEvent(event);
      expect(received).toEqual([event]);
    } finally {
      await server.close();
    }
  });
});

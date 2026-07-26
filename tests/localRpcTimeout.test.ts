import { describe, expect, test } from "vitest";
import { LocalRpcClient, LocalRpcServer } from "../src/rpc/RpcServer.js";
import { McpDaemonClient } from "../src/proxy/McpDaemonClient.js";
import { DebugMcpError } from "../src/utils/errors.js";

describe("local daemon RPC timeout", () => {
  test("distinguishes a connected long-running request timeout and allows an override", async () => {
    const server = new LocalRpcServer({
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
      handle: async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return { ready: true };
      }
    });
    const endpoint = await server.listen();
    try {
      const client = new LocalRpcClient({ ...endpoint, authToken: "test-token", timeoutMs: 10 });
      await expect(client.request("health", {})).rejects.toEqual(expect.objectContaining({
        code: "DaemonRequestTimeout",
        message: expect.stringContaining("waiting for c2000-debugd response")
      }));
      await expect(client.request("health", {}, 200)).resolves.toEqual({ ready: true });
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
});

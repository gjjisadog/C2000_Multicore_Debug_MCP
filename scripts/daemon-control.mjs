import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

export function runtimeDir() {
  return path.resolve(process.env.C2000_MCP_DAEMON_RUNTIME_DIR || "runtime");
}

export async function readInstance() {
  const directory = runtimeDir();
  const candidates = [
    path.join(directory, "debugd-instance.json")
  ];
  for (const file of candidates) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value && typeof value.port === "number" && typeof value.authTokenFile === "string") return { ...value, instanceFile: file };
    } catch {}
  }
  return undefined;
}

export async function readToken(instance) {
  return (await readFile(instance.authTokenFile, "utf8")).trim();
}

export async function rpc(instance, method, params = {}) {
  const token = await readToken(instance);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: instance.host || "127.0.0.1", port: instance.port });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Daemon RPC timed out"));
    }, 5000);
    const finish = callback => {
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    socket.once("error", error => finish(() => reject(error)));
    socket.on("data", chunk => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) throw new Error(response.error?.message || "Daemon RPC failed");
        finish(() => resolve(response.result));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      type: "request",
      id,
      method,
      authToken: token,
      params
    })}\n`));
  });
}

export async function health(instance) {
  try { return await rpc(instance, "health"); } catch { return undefined; }
}

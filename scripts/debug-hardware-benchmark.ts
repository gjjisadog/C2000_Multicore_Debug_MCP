import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const required = [
  "C2000_MCP_CCS_INSTALL_PATH", "C2000_MCP_CCXML_PATH", "C2000_CPU1_OUT", "C2000_CPU2_OUT",
  "C2000_CPU1_MAP", "C2000_CPU2_MAP", "C2000_MCP_HARDWARE_BENCHMARK"
];
const missing = required.filter(name => !process.env[name]);
if (missing.length > 0 || process.env.C2000_MCP_HARDWARE_BENCHMARK !== "1") {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: "Hardware benchmark requires explicit opt-in, CCS, XDS110, and CPU1/CPU2 artifacts.", missing })}\n`);
  process.exit(0);
}

const artifacts = {
  cpu1OutPath: process.env.C2000_CPU1_OUT!, cpu2OutPath: process.env.C2000_CPU2_OUT!,
  cpu1MapPath: process.env.C2000_CPU1_MAP!, cpu2MapPath: process.env.C2000_CPU2_MAP!
};
await Promise.all([process.env.C2000_MCP_CCXML_PATH!, ...Object.values(artifacts)].map(file => access(file)));
const outputDir = path.resolve(process.env.C2000_HARDWARE_BENCHMARK_OUTPUT ?? path.join("runtime", "debug-hardware-benchmark", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(outputDir, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    C2000_MCP_ADAPTER: "ccs",
    C2000_MCP_TOOL_PROFILE: "full",
    C2000_MCP_TOOL_SURFACE: "compatibility",
    C2000_MCP_CCS_INSTALL_PATH: process.env.C2000_MCP_CCS_INSTALL_PATH!,
    C2000_MCP_CCXML_PATH: process.env.C2000_MCP_CCXML_PATH!,
    C2000_MCP_ALLOWED_READ_ROOTS: [
      process.cwd(),
      process.env.C2000_MCP_CCS_INSTALL_PATH!,
      path.dirname(process.env.C2000_MCP_CCXML_PATH!),
      path.dirname(artifacts.cpu1OutPath),
      path.dirname(artifacts.cpu2OutPath)
    ].join(path.delimiter),
    C2000_MCP_ALLOWED_WRITE_ROOTS: outputDir,
    C2000_MCP_LOG_LEVEL: process.env.C2000_MCP_LOG_LEVEL ?? "info",
    C2000_MCP_LOG_FILE: path.join(outputDir, "server.log")
  }
});
const stderrChunks: Buffer[] = [];
transport.stderr?.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));
const client = new Client({ name: "c2000-debug-hardware-benchmark", version: "0.1.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "c2000_launchAndRunIpcAcceptance",
    arguments: {
      sessionName: "debug-speed-workflow-v2-hardware",
      sessionMode: "ephemeral",
      ccxmlPath: process.env.C2000_MCP_CCXML_PATH,
      device: "F28P65x",
      cpu1CoreId: 0, cpu1CoreName: "C28xx_CPU1", cpu1CorePattern: "C28xx_CPU1",
      cpu2CoreId: 2, cpu2CoreName: "C28xx_CPU2", cpu2CorePattern: "C28xx_CPU2",
      ...artifacts,
      resetType: "cpu",
      loadPolicy: "always",
      runSequence: { runCpu1First: true, runCpu2: true, settleMs: 0 },
      pollingStrategy: "adaptive",
      timeoutMs: Number.parseInt(process.env.C2000_HARDWARE_IPC_TIMEOUT_MS ?? "15000", 10),
      intervalMs: 100,
      collectDebugBundle: true,
      outputDir: path.join(outputDir, "bundle"),
      ipcReadyExpressions: [
        { coreId: 0, expression: "g_stDualCoreCpu1Watch.ulIpcPass", expected: 1 },
        { coreId: 0, expression: "g_stDualCoreCpu1Watch.ulMsgRamPass", expected: 1 },
        { coreId: 0, expression: "g_stDualCoreCpu1Watch.ulParamPass", expected: 1 },
        { coreId: 2, expression: "g_stDualCoreCpu2Watch.emStage", expected: 5 }
      ]
    }
  });
  const content = result.content.find(item => item.type === "text");
  if (!content || content.type !== "text") throw new Error("Hardware workflow returned no structured text result");
  let parsed: Record<string, any>;
  try { parsed = JSON.parse(content.text); }
  catch { throw new Error(`Hardware workflow failed: ${content.text}`); }
  await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(parsed, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputDir, result: parsed }, null, 2)}\n`);
  if (parsed.success !== true || parsed.cleanup?.sessionClosed !== true || parsed.cleanup?.probeLeaseReleased !== true) process.exitCode = 1;
} finally {
  await client.close();
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (stderr) await writeFile(path.join(outputDir, "mcp-stderr.log"), stderr);
}

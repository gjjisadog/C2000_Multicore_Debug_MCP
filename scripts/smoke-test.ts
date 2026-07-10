import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

const adapter = new MockDebugAdapter({
  expressionValues: {
    g_emHybrid30kCpu1Stage: { value: "3", type: "uint16_t", address: "0x00001234" },
    g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" },
    g_ulHybrid30kMsgRamPass: { value: "1", type: "uint32_t", address: "0x00002004" },
    g_ulHybrid30kParamPass: { value: "1", type: "uint32_t", address: "0x00002008" },
    g_ulHybrid30kCpu1ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00002010" },
    g_ulHybrid30kCpu2ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00012010" },
    g_emHybrid30kCpu2Stage: { value: "0", type: "uint16_t", address: "0x00018870" }
  }
});

const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
const handlers = createToolHandlers(manager);
const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-smoke-"));
const cpu1Out = path.join(tempDir, "cpu1.out");
const cpu2Out = path.join(tempDir, "cpu2.out");
await writeFile(cpu1Out, "cpu1-image");
await writeFile(cpu2Out, "cpu2-image");

const created = await handlers.createDebugSession({ sessionName: "smoke-f28p65x", coreMap });
if (!created.success || typeof created.sessionId !== "string") {
  throw new Error(`createDebugSession failed: ${JSON.stringify(created)}`);
}

await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
await handlers.resetCores({ sessionId: created.sessionId, coreIds: [0, 2], resetType: "cpu" });
await handlers.loadPrograms({
  sessionId: created.sessionId,
  programs: [
    { coreId: 0, programUri: cpu1Out },
    { coreId: 2, programUri: cpu2Out }
  ]
});
await handlers.runCore({ sessionId: created.sessionId, coreId: 0 });

const evaluate = await handlers.evaluateMany({
  sessionId: created.sessionId,
  coreId: 0,
  expressions: [
    "g_emHybrid30kCpu1Stage",
    "g_ulHybrid30kIpcPass",
    "g_ulHybrid30kMsgRamPass",
    "g_ulHybrid30kParamPass"
  ]
});
const snapshot = await handlers.getMulticoreSnapshot({ sessionId: created.sessionId });
const cpu2BootDiagnosis = await handlers.diagnoseCpu2Boot({ sessionId: created.sessionId, cpu1CoreId: 0, cpu2CoreId: 2 });
const runPauseIsolation = await handlers.verifyRunPauseIsolation({ sessionId: created.sessionId, settleMs: 1 });
const faultInjection = await handlers.assignExpression({
  sessionId: created.sessionId,
  coreId: 0,
  expression: "g_ulHybrid30kIpcPass",
  value: 0
});
const postFaultInjection = {
  cpu1: await handlers.evaluateMany({ sessionId: created.sessionId, coreId: 0, expressions: ["g_ulHybrid30kIpcPass"] }),
  cpu2: await handlers.evaluateMany({ sessionId: created.sessionId, coreId: 2, expressions: ["g_ulHybrid30kIpcPass"] })
};
const parameterSync = await handlers.compareExpressions({
  sessionId: created.sessionId,
  comparisons: [
    {
      label: "param-crc",
      left: { coreId: 0, expression: "g_ulHybrid30kCpu1ParamCrc" },
      right: { coreId: 2, expression: "g_ulHybrid30kCpu2ParamCrc" }
    },
    {
      label: "ipc-pass-after-fault-injection",
      left: { coreId: 0, expression: "g_ulHybrid30kIpcPass" },
      right: { coreId: 2, expression: "g_ulHybrid30kIpcPass" }
    }
  ]
});
const expressionSetWait = await handlers.waitForExpressionSet({
  sessionId: created.sessionId,
  conditions: [
    { label: "cpu1-stage", coreId: 0, expression: "g_emHybrid30kCpu1Stage", expected: "3" },
    { label: "cpu2-stage", coreId: 2, expression: "g_emHybrid30kCpu2Stage", expected: "0" }
  ],
  timeoutMs: 20,
  intervalMs: 5
});

console.log(JSON.stringify({ created, evaluate, snapshot, cpu2BootDiagnosis, runPauseIsolation, faultInjection, postFaultInjection, parameterSync, expressionSetWait }, null, 2));

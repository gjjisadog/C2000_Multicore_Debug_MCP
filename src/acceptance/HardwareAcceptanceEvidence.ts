import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtomicArtifactWriter } from "../artifacts/AtomicArtifactWriter.js";
import { sha256File } from "../utils/fileHash.js";
import {
  HARDWARE_ACCEPTANCE_SCHEMA_VERSION,
  hardwareAcceptanceEventSchema,
  hardwareAcceptanceManifestSchema,
  hardwareAcceptanceResultSchema,
  type HardwareAcceptanceCase,
  type HardwareAcceptanceEvent,
  type HardwareAcceptanceResult,
  type HardwareAcceptanceScope
} from "./HardwareAcceptanceSchemas.js";

export const HARDWARE_ACCEPTANCE_CASES: readonly {
  caseId: string;
  scope: Exclude<HardwareAcceptanceScope, "all">;
  title: string;
}[] = [
  { caseId: "A1", scope: "single-board", title: "Board registration and identity fencing" },
  { caseId: "A2", scope: "single-board", title: "CPU1/CPU2 independent connect" },
  { caseId: "A3", scope: "multicore", title: "CPU1/CPU2 independent run and pause" },
  { caseId: "A4", scope: "single-board", title: "Reset scope and observer invalidation" },
  { caseId: "B1", scope: "single-board", title: "CPU1 program load" },
  { caseId: "B2", scope: "multicore", title: "CPU2 load and GS RAM ownership" },
  { caseId: "B3", scope: "multicore", title: "Dual-core boot and IPC ready repeatability" },
  { caseId: "C", scope: "variables", title: "Online slow variable stream" },
  { caseId: "D", scope: "dlog", title: "Read-only target DLOG export" },
  { caseId: "E", scope: "erad", title: "F28P65x ERAD profiling" },
  { caseId: "F", scope: "trace", title: "Perfetto trace and failure bundle" },
  { caseId: "G", scope: "can", title: "Two-board CAN three-segment physical evidence" },
  { caseId: "H", scope: "two-board", title: "Multi-board concurrency and isolation" },
  { caseId: "I", scope: "soak", title: "Two-hour stability and recovery" }
] as const;

export function isHardwareOptedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.C2000_HARDWARE_TEST === "1";
}

export function requiredOptInReason(
  scope: HardwareAcceptanceScope,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!isHardwareOptedIn(env)) return "C2000_HARDWARE_TEST=1 is required; no target or probe was accessed";
  if ((scope === "can" || scope === "two-board" || scope === "all") && env.C2000_PCAN_HARDWARE_TEST !== "1") {
    return "C2000_PCAN_HARDWARE_TEST=1 is required; PCAN was not opened";
  }
  if ((scope === "two-board" || scope === "all") && env.C2000_TWO_BOARD_TEST !== "1") {
    return "C2000_TWO_BOARD_TEST=1 is required; no two-board permit was requested";
  }
  return null;
}

export async function createHostEnvironment(now = new Date()): Promise<HardwareAcceptanceResult["environment"]> {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string };
  return {
    windowsVersion: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    nodeVersion: process.version,
    repositoryCommitSha: repositoryCommitSha(),
    packageVersion: packageJson.version,
    ccsVersion: null,
    dssVersion: null,
    xds110Serials: [],
    pcan: {
      model: null,
      channel: process.env.C2000_PCAN_CHANNEL ?? null,
      driverVersion: null
    },
    firmwareCommitSha: process.env.C2000_FIRMWARE_COMMIT_SHA ?? null,
    operator: process.env.C2000_TEST_OPERATOR ?? null,
    testDate: now.toISOString()
  };
}

export function selectAcceptanceCases(scope: HardwareAcceptanceScope) {
  return scope === "all"
    ? [...HARDWARE_ACCEPTANCE_CASES]
    : HARDWARE_ACCEPTANCE_CASES.filter(item => item.scope === scope);
}

export function skippedCases(
  scope: HardwareAcceptanceScope,
  reason: string,
  timestamp = new Date().toISOString()
): HardwareAcceptanceCase[] {
  return selectAcceptanceCases(scope).map(item => ({
    ...item,
    status: "SKIPPED_NO_HARDWARE",
    evidenceLevel: "HOST_COMMAND_EVIDENCE",
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    reason,
    boardIds: [],
    coreIdentities: [],
    evidencePaths: [],
    details: {
      targetAccessAttempted: false,
      pcanOpened: false,
      mockResultPromoted: false
    }
  }));
}

export function unsupportedCases(
  scope: HardwareAcceptanceScope,
  reason: string,
  timestamp = new Date().toISOString()
): HardwareAcceptanceCase[] {
  return selectAcceptanceCases(scope).map(item => ({
    ...item,
    status: "SKIPPED_UNSUPPORTED",
    evidenceLevel: "HOST_COMMAND_EVIDENCE",
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    reason,
    boardIds: [],
    coreIdentities: [],
    evidencePaths: [],
    details: {
      targetAccessAttempted: false,
      mockResultPromoted: false
    }
  }));
}

export function overallStatus(cases: readonly HardwareAcceptanceCase[]): HardwareAcceptanceResult["overallStatus"] {
  if (cases.some(item => item.status === "FAIL_HARDWARE")) return "FAIL_HARDWARE";
  if (cases.length > 0 && cases.every(item => item.status === "PASS_HARDWARE")) return "PASS_HARDWARE";
  if (cases.some(item => item.status === "INCONCLUSIVE")) return "INCONCLUSIVE";
  if (cases.some(item => item.status === "SKIPPED_UNSUPPORTED")) return "SKIPPED_UNSUPPORTED";
  if (cases.some(item => item.status === "PASS_MOCK")) return "PASS_MOCK";
  return "SKIPPED_NO_HARDWARE";
}

export async function writeHardwareAcceptanceEvidence(input: {
  outputDirectory: string;
  runId: string;
  scope: HardwareAcceptanceScope;
  cases: HardwareAcceptanceCase[];
  startedAt: string;
  endedAt: string;
  incompleteReason?: string | null;
}): Promise<{ directory: string; result: HardwareAcceptanceResult }> {
  const writer = new AtomicArtifactWriter();
  const directory = path.resolve(input.outputDirectory);
  await writer.ensureDirectory(directory);
  const events: HardwareAcceptanceEvent[] = [
    {
      schemaVersion: HARDWARE_ACCEPTANCE_SCHEMA_VERSION,
      sequence: 1,
      runId: input.runId,
      eventType: "hardware-acceptance.started",
      timestamp: input.startedAt,
      monotonicTimestampNs: process.hrtime.bigint().toString(),
      scope: input.scope,
      caseId: null,
      payload: { targetAccessAuthorized: isHardwareOptedIn() }
    },
    ...input.cases.map((item, index) => ({
      schemaVersion: HARDWARE_ACCEPTANCE_SCHEMA_VERSION as 1,
      sequence: index + 2,
      runId: input.runId,
      eventType: "hardware-acceptance.case.completed",
      timestamp: item.endedAt,
      monotonicTimestampNs: (process.hrtime.bigint() + BigInt(index + 1)).toString(),
      scope: input.scope,
      caseId: item.caseId,
      payload: {
        status: item.status,
        evidenceLevel: item.evidenceLevel,
        reason: item.reason
      }
    }))
  ];
  const result = hardwareAcceptanceResultSchema.parse({
    schemaVersion: HARDWARE_ACCEPTANCE_SCHEMA_VERSION,
    runId: input.runId,
    selectedScope: input.scope,
    overallStatus: overallStatus(input.cases),
    environment: await createHostEnvironment(new Date(input.startedAt)),
    optIn: {
      hardware: isHardwareOptedIn(),
      pcan: process.env.C2000_PCAN_HARDWARE_TEST === "1",
      twoBoard: process.env.C2000_TWO_BOARD_TEST === "1"
    },
    safety: {
      highVoltageBusConnected: false,
      powerStageDriven: false,
      pwmAutomaticallyEnabled: false,
      tripAutomaticallyReleased: false,
      protectionThresholdsModified: false,
      unknownFirmwareAllowed: false
    },
    cases: input.cases,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    completeness: input.incompleteReason ? "INCOMPLETE" : "COMPLETE"
  });
  events.forEach(event => hardwareAcceptanceEventSchema.parse(event));

  const resultPath = path.join(directory, "hardware-acceptance-result.json");
  const eventsPath = path.join(directory, "hardware-acceptance-events.jsonl");
  const reportPath = path.join(directory, "HARDWARE_ACCEPTANCE_REPORT.md");
  await writer.writeJson(resultPath, result);
  await writer.writeJsonLines(eventsPath, events);
  await writer.writeText(reportPath, renderReport(result));

  const generatedFiles = [];
  for (const filePath of [resultPath, eventsPath, reportPath]) {
    const info = await stat(filePath);
    generatedFiles.push({
      path: path.basename(filePath),
      sha256: await sha256File(filePath),
      size: info.size
    });
  }
  const manifestPath = path.join(directory, "hardware-acceptance-manifest.json");
  await writer.writeJson(manifestPath, hardwareAcceptanceManifestSchema.parse({
    schemaVersion: HARDWARE_ACCEPTANCE_SCHEMA_VERSION,
    runId: input.runId,
    selectedScope: input.scope,
    resultPath: path.basename(resultPath),
    eventsPath: path.basename(eventsPath),
    reportPath: path.basename(reportPath),
    generatedFiles,
    completeness: input.incompleteReason ? "INCOMPLETE" : "COMPLETE",
    incompleteReason: input.incompleteReason ?? null
  }));
  return { directory, result };
}

function renderReport(result: HardwareAcceptanceResult): string {
  const rows = result.cases.map(item =>
    `| ${item.caseId} | ${item.title} | ${item.status} | ${item.evidenceLevel} | ${item.reason ?? ""} |`
  ).join("\n");
  const caseStatus = (caseId: string) => result.cases.find(item => item.caseId === caseId)?.status ?? "SKIPPED_UNSUPPORTED";
  return `# F28P65x Hardware Acceptance Report

No Mock result is promoted to hardware evidence. A skipped preflight is not a hardware pass.

## 1. Actual hardware environment

- Run ID: \`${result.runId}\`
- Host: \`${result.environment.windowsVersion} ${result.environment.architecture}\`
- Node.js: \`${result.environment.nodeVersion}\`
- Package: \`${result.environment.packageVersion}\`
- Hardware opt-in: \`${result.optIn.hardware}\`
- PCAN opt-in: \`${result.optIn.pcan}\`
- Two-board opt-in: \`${result.optIn.twoBoard}\`
- Overall status: \`${result.overallStatus}\`

No XDS110, board, or PCAN identity was established in this run.

## 2. Repository commit

\`${result.environment.repositoryCommitSha ?? "unknown"}\`

## 3. Test firmware SHA

\`${result.environment.firmwareCommitSha ?? "not provided; no firmware was executed"}\`

## 4. CCS, DSS, XDS110, and PCAN versions

- CCS: \`${result.environment.ccsVersion ?? "not started / not measured"}\`
- DSS: \`${result.environment.dssVersion ?? "not started / not measured"}\`
- XDS110 serials: \`${result.environment.xds110Serials.join(", ") || "not enumerated"}\`
- PCAN model: \`${result.environment.pcan.model ?? "not opened"}\`
- PCAN channel: \`${result.environment.pcan.channel ?? "not opened"}\`
- PCAN driver: \`${result.environment.pcan.driverVersion ?? "not loaded"}\`

## 5. Acceptance result matrix

| Case | Acceptance | Status | Evidence | Reason |
|---|---|---|---|---|
${rows}

## 6. Evidence levels

This run contains only \`HOST_COMMAND_EVIDENCE\` proving that hardware gates
stopped before target or bus access. It contains no
\`TARGET_STATE_EVIDENCE\`, \`BUS_EVIDENCE\`, or
\`FULL_HARDWARE_EVIDENCE\`.

## 7. CPU1/CPU2 independent control

\`${caseStatus("A2")}\` / \`${caseStatus("A3")}\`. No core was connected,
continued, halted, reset, or loaded.

## 8. GS RAM ownership

\`${caseStatus("B2")}\`. No MEMCFG register was read or written and no real
linker map was accepted as hardware evidence.

## 9. IPC boot repeatability

\`${caseStatus("B3")}\`. Zero cold/reload cycles were executed; no latency or
success-rate statistic exists.

## 10. Variable-stream measured performance

\`${caseStatus("C")}\`. No 10/20/100 ms hardware stream or 30-minute run was
executed, so no hardware polling latency, overrun, miss, or drop rate is
reported.

## 11. DLOG consistency

\`${caseStatus("D")}\`. No target buffer was read and no CSV/JSON hardware
alignment was measured.

## 12. ERAD repeatability

\`${caseStatus("E")}\`. No ERAD resource was configured or mutated and no
cycle distribution was measured.

## 13. Perfetto Trace time domains

\`${caseStatus("F")}\`. No hardware Trace was generated. The implementation
still treats host monotonic, wall clock, PCAN timestamps, MCU sample indices,
DLOG relative time, and ERAD cycles as distinct domains unless calibrated.

## 14. Two-board CAN three-segment statistics

\`${caseStatus("G")}\`. TX, PCAN bus, RX, match, loss, duplicate, ordering,
payload, period, and jitter counts are all unmeasured. No
\`FULL_HARDWARE_EVIDENCE\` is claimed.

## 15. Multi-board concurrency

\`${caseStatus("H")}\`. No pair permit, dual XDS110 route, or 50-round
concurrency test was executed.

## 16. Long-duration stability

\`${caseStatus("I")}\`. The two-hour stability/recovery test was not executed.

## 17. Fixes made in this round

- Added a P0 general hardware opt-in gate before CCS/DSS/XDS110 target access.
- Added independent PCAN and two-board opt-in gates.
- Moved the readiness/MCP hardware gate before their build step.
- Added a supported-Node fail-closed gate before hardware access.
- Added atomic result/event/manifest/report generation and no Mock promotion.

## 18. Unfinished or unexecuted hardware tests

All cases A1 through I are unexecuted because the required opt-in, board
configuration, ccxml, firmware, XDS110 identity, and PCAN/two-board
configuration were not available.

## 19. Remaining risks

- Real F28P65x behavior for variable stream, DLOG, ERAD, Trace, and failure
  collection remains unverified.
- Existing CCS and PCAN scripts prove only the evidence they actually capture;
  a PCAN preflight must never be reported as CAN acceptance.
- Dedicated automated target-side executors for every Round 8 scope remain to
  be implemented and reviewed on an isolated low-risk rig.
- The default host Node.js may differ from the supported acceptance runtime;
  hardware entry points now reject unsupported versions.

## 20. Artifact files

- \`HARDWARE_ACCEPTANCE_REPORT.md\`
- \`hardware-acceptance-result.json\`
- \`hardware-acceptance-events.jsonl\`
- \`hardware-acceptance-manifest.json\`

## Safety statement

This run did not authorize high-voltage bus connection, power-stage drive, automatic PWM enable,
Trip release, protection-threshold changes, or unknown firmware.
`;
}

function repositoryCommitSha(): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRepository } from "../storage/repositories/ArtifactRepository.js";
import type { BoardGroupBarrierRecord } from "../storage/repositories/BoardGroupBarrierRepository.js";
import type { BoardGroupRecord } from "../storage/repositories/BoardGroupRepository.js";
import type { CanCampaignRecord, CanMatrixCaseRecord } from "../storage/repositories/CanCampaignRepository.js";
import type { CanTestResult } from "../storage/repositories/CanTestResultRepository.js";
import type { CanAdapterInfo, CanCapture } from "./CanBusAdapter.js";

/** Produces bounded evidence artifacts; it never turns Mock captures into physical-bus claims. */
export class CanReportService {
  constructor(private readonly artifacts: ArtifactRepository, private readonly baseDirectory: string) {}

  async write(input: { jobId: string; group: BoardGroupRecord; barriers: BoardGroupBarrierRecord[]; results: Array<Required<CanTestResult>>; campaign?: CanCampaignRecord; cases?: CanMatrixCaseRecord[]; adapter: CanAdapterInfo; captures: CanCapture[]; simulation: boolean }): Promise<Array<{ artifactType: string; path: string }>> {
    const directory = path.join(this.baseDirectory, input.jobId);
    await mkdir(directory, { recursive: true });
    const summary = reportJson(input);
    const files = [
      { artifactType: "can-report-json", path: path.join(directory, "can-report.json"), content: JSON.stringify(summary, null, 2) },
      { artifactType: "can-report-markdown", path: path.join(directory, "can-report.md"), content: reportMarkdown(summary) },
      { artifactType: "can-report-junit", path: path.join(directory, "can-report.junit.xml"), content: reportJunit(summary) }
    ];
    for (const file of files) {
      await writeFile(file.path, file.content, "utf8");
      const fileStat = await stat(file.path);
      this.artifacts.add({ jobId: input.jobId, artifactType: file.artifactType, path: file.path, sha256: createHash("sha256").update(file.content).digest("hex"), size: fileStat.size });
    }
    return files.map(file => ({ artifactType: file.artifactType, path: file.path }));
  }
}

function reportJson(input: Parameters<CanReportService["write"]>[0]): Record<string, unknown> {
  const trace = input.adapter.independentBusVerification ? input.captures.slice(0, 10_000) : [];
  return {
    schemaVersion: 1,
    job: { jobId: input.jobId, campaign: input.campaign, cases: input.cases },
    group: input.group,
    barriers: input.barriers,
    results: input.results,
    adapter: { ...input.adapter, simulation: input.simulation, independentBusVerification: input.adapter.independentBusVerification },
    canTrace: input.adapter.independentBusVerification ? { capturedFrames: trace, truncated: input.captures.length > trace.length } : { capturedFrames: [], unavailableReason: input.adapter.reason ?? "No independent physical-bus adapter capture" },
    summary: { status: input.group.status, resultCount: input.results.length, capturesRecordedByAdapter: input.captures.length, physicalBusVerified: input.adapter.independentBusVerification }
  };
}

function reportMarkdown(summary: Record<string, unknown>): string {
  const job = summary.job as { jobId: string };
  const group = summary.group as BoardGroupRecord;
  const adapter = summary.adapter as CanAdapterInfo & { simulation: boolean };
  const results = summary.results as Array<Required<CanTestResult>>;
  return `# Two-Board CAN Report\n\n- Job: ${job.jobId}\n- Group: ${group.groupId}\n- Status: ${group.status}\n- Adapter: ${adapter.name}\n- Simulation: ${adapter.simulation}\n- Independent physical-bus verification: ${adapter.independentBusVerification}\n\n## Evidence phases\n\n${results.map(result => `- ${result.phase}: ${result.status}`).join("\n") || "- No result rows"}\n\n## Truthfulness\n\n${adapter.independentBusVerification ? "Frames are backed by the configured independent adapter capture." : "No independent physical-bus capture exists; this report contains firmware/debug and adapter evidence only, not a physical CAN claim."}\n`;
}

function reportJunit(summary: Record<string, unknown>): string {
  const results = summary.results as Array<Required<CanTestResult>>;
  const required = [
    ["safety", "SAFETY"], ["configuration", "BARRIER"], ["handshake", "CROSS_BOARD"], ["tx_rx", "DIRECTION"],
    ["sequence", "SEQUENCE"], ["crc", "CRC"], ["heartbeat", "HEARTBEAT"], ["timeout", "TIMEOUT"],
    ["busoff", "BUS_OFF"], ["reset_rejoin", "RESET_REJOIN"]
  ] as const;
  const cases = required.map(([name, phase]) => {
    const matches = results.filter(result => result.phase === phase);
    const status = matches.some(item => item.status === "FAILED") ? "FAILED" : matches.length === 0 || matches.every(item => item.status === "SKIPPED") ? "SKIPPED" : "PASSED";
    const body = status === "FAILED" ? `<failure message="${escapeXml(`${phase} failed`)}"/>` : status === "SKIPPED" ? `<skipped message="${escapeXml(`${phase} unsupported or not declared`)}"/>` : "";
    return `<testcase classname="two-board-can" name="${escapeXml(name)}">${body}</testcase>`;
  });
  const failures = cases.filter(item => item.includes("<failure")).length;
  const skipped = cases.filter(item => item.includes("<skipped")).length;
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="two-board-can" tests="${cases.length}" failures="${failures}" skipped="${skipped}">${cases.join("")}</testsuite>`;
}

function escapeXml(value: string): string { return value.replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!); }

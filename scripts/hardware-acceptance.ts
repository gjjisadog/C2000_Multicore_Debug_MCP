import path from "node:path";
import {
  requiredOptInReason,
  selectAcceptanceCases,
  skippedCases,
  unsupportedCases,
  writeHardwareAcceptanceEvidence
} from "../src/acceptance/HardwareAcceptanceEvidence.js";
import {
  hardwareAcceptanceScopeSchema,
  type HardwareAcceptanceScope
} from "../src/acceptance/HardwareAcceptanceSchemas.js";

const options = parseArguments(process.argv.slice(2));
const scope = hardwareAcceptanceScopeSchema.parse(options.scope ?? "all");
const startedAt = new Date().toISOString();
const runId = options.runId ?? `hardware-${scope}-${startedAt.replace(/[:.]/g, "-")}`;
const outputRoot = path.resolve(options.artifactsRoot ?? process.env.C2000_HARDWARE_ARTIFACTS_ROOT ?? "artifacts/hardware-acceptance");
const outputDirectory = path.join(outputRoot, runId);

const selectedCases = selectAcceptanceCases(scope);
const cases = [];
let incompleteReason: string | null = null;
for (const selected of selectedCases) {
  const optInReason = requiredOptInReason(selected.scope);
  if (optInReason) {
    cases.push(skippedCases(selected.scope, optInReason, startedAt).find(item => item.caseId === selected.caseId)!);
    continue;
  }
  const reason = [
    `The ${selected.scope} evidence orchestrator is installed, but this repository does not yet have a dedicated`,
    "fully automated target-side executor for this scope. Run the existing explicit CCS/PCAN acceptance",
    "entry where available and do not classify its preflight as PASS_HARDWARE."
  ].join(" ");
  cases.push(unsupportedCases(selected.scope, reason, startedAt).find(item => item.caseId === selected.caseId)!);
  incompleteReason = reason;
}

const endedAt = new Date().toISOString();
const written = await writeHardwareAcceptanceEvidence({
  outputDirectory,
  runId,
  scope,
  cases,
  startedAt,
  endedAt,
  incompleteReason
});

const output = {
  ...written.result,
  artifactDirectory: written.directory
};
process.stdout.write(`${JSON.stringify(output, null, options.json ? 0 : 2)}\n`);
if (written.result.overallStatus === "FAIL_HARDWARE") process.exitCode = 1;
if (written.result.overallStatus === "INCONCLUSIVE") process.exitCode = 2;

function parseArguments(args: string[]): {
  scope?: HardwareAcceptanceScope;
  artifactsRoot?: string;
  runId?: string;
  json: boolean;
} {
  const parsed: { scope?: HardwareAcceptanceScope; artifactsRoot?: string; runId?: string; json: boolean } = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--scope") parsed.scope = args[++index] as HardwareAcceptanceScope;
    else if (arg === "--artifacts-root") parsed.artifactsRoot = args[++index];
    else if (arg === "--run-id") parsed.runId = args[++index];
    else throw new Error(`Unknown hardware acceptance argument: ${arg}`);
  }
  return parsed;
}

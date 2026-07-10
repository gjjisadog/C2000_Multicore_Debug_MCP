import { spawn } from "node:child_process";
import { evaluateHostVerificationGate, type HostVerificationStepResult, type HostVerificationStepStatus } from "../src/hostVerificationGate.js";

const acceptanceEvidencePlanId = "c2000_multicore_acceptance_evidence_plan";

const stepsToRun = [
  { name: "debug-boundary-source-scan", command: "npm run verify:debug-boundary" },
  { name: "typescript-build", command: "npm run build --silent" },
  { name: "unit-and-contract-tests", command: "npm test -- --reporter=dot" },
  { name: "mcp-stdio-smoke", command: "npm run smoke:mcp" },
  { name: "hardware-acceptance-readiness", command: "npm run acceptance:ready", readiness: true }
];

const results: HostVerificationStepResult[] = [];

for (const step of stepsToRun) {
  const result = await runStep(step.name, step.command, step.readiness === true);
  results.push(result);

  if (!step.readiness && result.exitCode !== 0) {
    break;
  }
}

const evaluation = evaluateHostVerificationGate(results);
if (evaluation.acceptanceEvidenceError) {
  process.stderr.write(`acceptanceEvidence is missing or malformed in acceptance readiness output; expected ${acceptanceEvidencePlanId}: ${evaluation.acceptanceEvidenceError}\n`);
}

const { exitCode, acceptanceEvidenceError: _acceptanceEvidenceError, ...output } = evaluation;
console.log(JSON.stringify(output, null, 2));

process.exitCode = exitCode;

async function runStep(name: string, command: string, readiness = false): Promise<HostVerificationStepResult> {
  const output = await exec(command);
  return {
    name,
    command,
    exitCode: output.exitCode,
    status: stepStatus(output.exitCode, readiness),
    stdoutTail: tail(output.stdout),
    stderrTail: tail(output.stderr),
    readinessJson: readiness ? extractJsonObject(output.stdout) : undefined
  };
}

function stepStatus(exitCode: number, readiness: boolean): HostVerificationStepStatus {
  if (readiness) {
    return exitCode === 0 ? "passed" : exitCode === 2 ? "blocked" : "failed";
  }
  return exitCode === 0 ? "passed" : "failed";
}

function exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", chunk => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));
    child.on("close", code => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
    child.on("error", error => {
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}\n${error.message}`
      });
    });
  });
}

function extractJsonObject(output: string): Record<string, any> | undefined {
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== "{") {
      continue;
    }
    try {
      const parsed = JSON.parse(output.slice(index).trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      // Keep scanning. npm script headers may precede the JSON payload.
    }
  }
  return undefined;
}

function tail(value: string, maxLength = 80_000): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

#!/usr/bin/env node
import { parseSetupArgs, runSetup, setupHelp, SetupHelpRequested } from "./setup.js";

async function main(): Promise<void> {
  try {
    const options = parseSetupArgs(process.argv.slice(2));
    const result = await runSetup(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    process.stdout.write([
      `C2000 Multicore MCP ${result.version} installed successfully.`,
      `Runtime action: ${result.runtimeAction}`,
      result.builtAt ? `Build: ${result.builtAt}` : undefined,
      result.sourceRevision ? `Source revision: ${result.sourceRevision}${result.sourceDirty ? " (dirty)" : ""}` : undefined,
      `Node runtime: ${result.runtimeExecutable}`,
      `MCP entrypoint: ${result.entrypoint}`,
      `Config: ${result.configPath}`,
      `Codex registration: ${result.registration}`,
      result.codexConfigPath ? `Codex config: ${result.codexConfigPath}` : undefined,
      result.skillDirectory ? `Skill: ${result.skillDirectory}` : undefined,
      result.doctorPassed ? "Doctor: passed" : "Doctor: skipped",
      "Restart Codex (or its MCP servers) to load the new server."
    ].filter(Boolean).join("\n") + "\n");
  } catch (error) {
    if (error instanceof SetupHelpRequested) {
      process.stdout.write(setupHelp);
      return;
    }
    process.stderr.write(`c2000-multicore-setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();

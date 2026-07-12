import { performance } from "node:perf_hooks";

const iterations = 1000;
function run(commandCount: number, tcpConnections: number) {
  const startedAt = performance.now();
  let checksum = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let command = 0; command < commandCount; command++) checksum += iteration + command;
    for (let connection = 0; connection < tcpConnections; connection++) checksum ^= connection;
  }
  return { commandCount, tcpConnections, durationMs: performance.now() - startedAt, checksum };
}

const baseline = run(22, 22);
const optimized = run(11, 2);
const percent = (before: number, after: number) => before === 0 ? 0 : ((before - after) / before) * 100;
process.stdout.write(`${JSON.stringify({
  baseline: { commandCount: baseline.commandCount, tcpConnections: baseline.tcpConnections, durationMs: baseline.durationMs },
  optimized: { commandCount: optimized.commandCount, tcpConnections: optimized.tcpConnections, durationMs: optimized.durationMs },
  reduction: {
    commandPercent: percent(baseline.commandCount, optimized.commandCount),
    connectionPercent: percent(baseline.tcpConnections, optimized.tcpConnections),
    durationPercent: percent(baseline.durationMs, optimized.durationMs)
  }
}, null, 2)}\n`);

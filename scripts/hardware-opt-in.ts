export function requireHardwareOptIn(options: {
  pcan?: boolean;
  twoBoard?: boolean;
  operation: string;
}): void {
  const missing: string[] = [];
  if (process.env.C2000_HARDWARE_TEST !== "1") missing.push("C2000_HARDWARE_TEST=1");
  if (options.pcan && process.env.C2000_PCAN_HARDWARE_TEST !== "1") missing.push("C2000_PCAN_HARDWARE_TEST=1");
  if (options.twoBoard && process.env.C2000_TWO_BOARD_TEST !== "1") missing.push("C2000_TWO_BOARD_TEST=1");
  if (missing.length === 0) return;
  process.stdout.write(`${JSON.stringify({
    status: "SKIPPED_NO_HARDWARE",
    evidenceLevel: "HOST_COMMAND_EVIDENCE",
    operation: options.operation,
    reason: `${missing.join(", ")} required; no target, probe, or PCAN hardware was accessed`,
    targetAccessAttempted: false,
    pcanOpened: false,
    mockResultPromoted: false
  }, null, 2)}\n`);
  process.exit(0);
}

export function requireSupportedHardwareRuntime(operation: string): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12);
  if (supported) return;
  process.stdout.write(`${JSON.stringify({
    status: "INCONCLUSIVE",
    evidenceLevel: "HOST_COMMAND_EVIDENCE",
    operation,
    reason: `Unsupported Node.js ${process.version}; hardware access requires Node 20.19+ or 22.12+`,
    targetAccessAttempted: false,
    pcanOpened: false,
    mockResultPromoted: false
  }, null, 2)}\n`);
  process.exit(2);
}

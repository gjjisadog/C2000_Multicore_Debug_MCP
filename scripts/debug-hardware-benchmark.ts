const required = ["C2000_MCP_CCS_INSTALL_PATH", "C2000_MCP_CCXML_PATH", "C2000_MCP_HARDWARE_BENCHMARK"];
const missing = required.filter(name => !process.env[name]);
if (missing.length > 0 || process.env.C2000_MCP_HARDWARE_BENCHMARK !== "1") {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: "Hardware benchmark requires explicit opt-in, CCS, XDS110, and target configuration.", missing })}\n`);
  process.exit(0);
}
process.stderr.write("Hardware benchmark must be run through the configured high-level MCP workflow so probe queue and explicit-core safety remain active.\n");
process.exit(2);

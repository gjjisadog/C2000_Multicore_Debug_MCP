import { DEBUG_BOUNDARY_SCAN_ROOTS, findDebugBoundarySourceOffenders } from "../src/debug/sourceBoundaryScan.js";

const offenders = await findDebugBoundarySourceOffenders();
const result = {
  success: offenders.length === 0,
  debugBoundarySourceScan: {
    roots: [...DEBUG_BOUNDARY_SCAN_ROOTS],
    offenders
  }
};

console.log(JSON.stringify(result, null, 2));

if (offenders.length > 0) {
  process.exitCode = 1;
}

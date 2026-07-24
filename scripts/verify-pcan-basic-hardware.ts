import { PcanBasicNativeDriver } from "../src/can/pcan/PcanBasicNativeDriver.js";
import { PCAN_BITRATES, PCAN_CHANNELS } from "../src/can/pcan/PcanBasicConstants.js";

if (process.env.C2000_PCAN_HARDWARE_TEST !== "1") {
  process.stdout.write(`${JSON.stringify({ status: "SKIPPED", reason: "Set C2000_PCAN_HARDWARE_TEST=1 to opt in; no PCAN hardware was accessed" }, null, 2)}\n`);
  process.exit(0);
}

const channelName = process.env.C2000_PCAN_CHANNEL ?? "PCAN_USBBUS1";
const bitrate = Number(process.env.C2000_PCAN_BITRATE ?? "500000");
const channel = PCAN_CHANNELS[channelName];
const baud = PCAN_BITRATES[bitrate];
if (channel === undefined || baud === undefined) throw new Error(`Unsupported PCAN channel/bitrate: ${channelName}/${bitrate}`);

const driver = new PcanBasicNativeDriver(process.env.C2000_PCAN_BASIC_LIBRARY);
await driver.initialize(channel, baud);
try {
  const status = await driver.getStatus(channel);
  process.stdout.write(`${JSON.stringify({
    status: "PREFLIGHT_ONLY",
    channel: channelName,
    bitrate,
    libraryPath: driver.libraryPath,
    busStatus: status,
    versions: await driver.versions(),
    twoBoardCanAcceptancePassed: false
  }, null, 2)}\n`);
} finally {
  await driver.uninitialize(channel);
}

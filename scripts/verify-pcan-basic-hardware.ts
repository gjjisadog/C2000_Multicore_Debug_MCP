import { PcanBasicNativeDriver } from "../src/can/pcan/PcanBasicNativeDriver.js";
import { PCAN_BITRATES, PCAN_CHANNELS } from "../src/can/pcan/PcanBasicConstants.js";
import { requireHardwareOptIn, requireSupportedHardwareRuntime } from "./hardware-opt-in.js";

requireHardwareOptIn({ operation: "verify:pcan:hardware", pcan: true });
requireSupportedHardwareRuntime("verify:pcan:hardware");

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

import { describe, expect, test } from "vitest";
import { FakePcanBasicDriver } from "../src/can/pcan/FakePcanBasicDriver.js";
import { PcanBasicCanBusAdapter } from "../src/can/pcan/PcanBasicCanBusAdapter.js";

describe("PcanBasicCanBusAdapter", () => {
  test("sends and receives classical standard and extended frames through the driver", async () => {
    const driver = new FakePcanBasicDriver();
    const adapter = new PcanBasicCanBusAdapter({ adapterId: "pcan-1", channel: "PCAN_USBBUS1", bitrate: 500000 }, driver);
    await adapter.openSession({ jobId: "job-a", boardIds: ["a", "b"], faults: [] });
    await adapter.send({ sourceBoardId: "a", targetBoardId: "b", frame: { id: 0x123, data: [1, 2], extended: false } });
    driver.reads.push({ id: 0x1abcde, data: [3, 4], extended: true, timestampMicros: 123 });
    await expect(adapter.receive({ sourceBoardId: "a", targetBoardId: "b", timeoutMs: 5 })).resolves.toEqual({ id: 0x1abcde, data: [3, 4], extended: true });
    expect(driver.writes).toEqual([{ id: 0x123, data: [1, 2], extended: false }]);
    await adapter.close();
    expect(driver.initialized).toBe(false);
  });

  test("fails closed on bus-off and always releases the channel", async () => {
    const driver = new FakePcanBasicDriver();
    const adapter = new PcanBasicCanBusAdapter({ adapterId: "pcan-1", channel: "PCAN_USBBUS1", bitrate: 500000 }, driver);
    await adapter.open({ jobId: "job-a", boardIds: ["a", "b"], faults: [] });
    driver.status = { code: 0x10, busWarning: false, busPassive: false, busOff: true };
    await expect(adapter.send({ sourceBoardId: "a", targetBoardId: "b", frame: { id: 1, data: [], extended: false } })).rejects.toMatchObject({ code: "PcanBusOff" });
    await adapter.close();
    const next = new PcanBasicCanBusAdapter({ adapterId: "pcan-2", channel: "PCAN_USBBUS1", bitrate: 500000 }, new FakePcanBasicDriver());
    await expect(next.open({ jobId: "job-b", boardIds: ["a", "b"], faults: [] })).resolves.toBeUndefined();
    await next.close();
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isSupportedPcanBasicPlatform, resolvePcanBasicLibrary } from "../src/can/pcan/PcanBasicLibraryResolver.js";
import { PCAN_CHANNELS } from "../src/can/pcan/PcanBasicConstants.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("PCAN native platform support", () => {
  test("supports Windows x64 and macOS Intel/Apple Silicon", () => {
    expect(isSupportedPcanBasicPlatform("win32", "x64")).toBe(true);
    expect(isSupportedPcanBasicPlatform("darwin", "x64")).toBe(true);
    expect(isSupportedPcanBasicPlatform("darwin", "arm64")).toBe(true);
    expect(isSupportedPcanBasicPlatform("win32", "arm64")).toBe(false);
    expect(isSupportedPcanBasicPlatform("linux", "x64")).toBe(false);
  });

  test("discovers the newest MacCAN libPCBUSB in configured directories", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pcan-library-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "libPCBUSB.0.12.2.dylib"), "old");
    await writeFile(path.join(directory, "libPCBUSB.0.13.dylib"), "current");

    await expect(resolvePcanBasicLibrary(undefined, {
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
      searchDirectories: [directory]
    })).resolves.toBe(path.join(directory, "libPCBUSB.0.13.dylib"));
  });

  test("reports unsupported platform and missing MacCAN library explicitly", async () => {
    await expect(resolvePcanBasicLibrary(undefined, { platform: "linux", arch: "x64", env: { PATH: "" } }))
      .rejects.toMatchObject({ code: "PcanPlatformUnsupported" });
    await expect(resolvePcanBasicLibrary(undefined, { platform: "darwin", arch: "arm64", env: { PATH: "" }, searchDirectories: [] }))
      .rejects.toMatchObject({ code: "PcanLibraryNotFound", message: expect.stringContaining("MacCAN libPCBUSB") });
  });

  test("uses PEAK's non-linear USB channel handles above channel eight", () => {
    expect(PCAN_CHANNELS.PCAN_USBBUS1).toBe(0x51);
    expect(PCAN_CHANNELS.PCAN_USBBUS8).toBe(0x58);
    expect(PCAN_CHANNELS.PCAN_USBBUS9).toBe(0x509);
    expect(PCAN_CHANNELS.PCAN_USBBUS16).toBe(0x510);
  });
});

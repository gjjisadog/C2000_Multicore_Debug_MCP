import { describe, expect, test } from "vitest";
import { recoverDebugProbe, runHardwarePreflight } from "../src/hardware/preflight.js";

const xdsdfuOutput = `
USB Device Firmware Upgrade Utility

Scanning USB buses for supported XDS110 devices...

<<<< Device 0 >>>>

VID: 0x0451    PID: 0xbef3
Device Name:   XDS110 Embed with CMSIS-DAP
Version:       3.0.0.43
Manufacturer:  Texas Instruments
Serial Num:    CL650001
Mode:          Runtime
Configuration: Standard

Found 1 device.
`;

describe("hardware preflight", () => {
  test("automatically terminates only probe-owner processes after obtaining the queue lease", async () => {
    let occupied = true;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const execFile = async (command: string) => {
      if (command === "ps") return {
        stdout: occupied
          ? " 58893 1 00:10:00 /Applications/ti/ccs/DebugServer/bin/DSLite --config /targets/a.ccxml\n 58894 1 00:10:00 /Applications/ti/ccs/DebugServer/bin/DSLite --config /targets/b.ccxml\n 60000 1 00:20:00 /Applications/ti/ccs/ccs.app/Contents/MacOS/ccstudio\n"
          : " 58894 1 00:10:00 /Applications/ti/ccs/DebugServer/bin/DSLite --config /targets/b.ccxml\n 60000 1 00:20:00 /Applications/ti/ccs/ccs.app/Contents/MacOS/ccstudio\n",
        stderr: ""
      };
      return { stdout: "", stderr: "" };
    };
    const recovery = await recoverDebugProbe({
      policy: "terminate-external",
      targetCcxmlPath: "/targets/a.ccxml",
      execFile,
      settleMs: 0,
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") occupied = false;
        if (signal === 0 && !occupied) Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });

    expect(recovery).toMatchObject({ attempted: true, recovered: true, terminatedPids: [58893], remainingOwners: [] });
    expect(signals.some(([pid]) => pid === 58894)).toBe(false);
    expect(signals.some(([pid]) => pid === 60000)).toBe(false);
  });

  test("safe recovery policies report an owner without terminating it", async () => {
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const recovery = await recoverDebugProbe({
      policy: "owned-and-stale",
      execFile: async command => command === "ps"
        ? { stdout: " 58893 1 00:10:00 /Applications/ti/ccs/DebugServer/bin/DSLite --config target.ccxml\n", stderr: "" }
        : { stdout: "", stderr: "" },
      killProcess: (pid, signal) => { signals.push([pid, signal]); }
    });

    expect(recovery).toMatchObject({ attempted: false, recovered: false, terminatedPids: [] });
    expect(signals).toEqual([]);
  });
  test("enumerates XDS110 devices and filters possible debug owners", async () => {
    const result = await runHardwarePreflight({
      ccsInstallPath: "/Applications/ti/ccs2100/ccs",
      execFile: async (command, args) => {
        if (command.endsWith("/xdsdfu") && args[0] === "-e") {
          return { stdout: xdsdfuOutput, stderr: "" };
        }
        if (command === "ps") {
          return {
            stdout: [
              "  100 ./DSLite",
              "  101 tsx scripts/ccs-hardware-acceptance.ts",
              "  102 /Applications/ti/ccs/ccstudio",
              "  103 /usr/bin/zsh"
            ].join("\n"),
            stderr: ""
          };
        }
        throw new Error(`unexpected command: ${command}`);
      }
    });

    expect(result.xdsdfu).toEqual(expect.objectContaining({
      ok: true,
      devices: [
        expect.objectContaining({
          serialNumber: "CL650001",
          mode: "Runtime",
          configuration: "Standard"
        })
      ]
    }));
    expect(result.debugProcesses).toEqual([
      "  100 ./DSLite",
      "  102 /Applications/ti/ccs/ccstudio"
    ]);
    expect(result.debugProcessDetails).toEqual([
      {
        pid: 100,
        command: "./DSLite",
        kind: "DSLite",
        rawLine: "  100 ./DSLite"
      },
      {
        pid: 102,
        command: "/Applications/ti/ccs/ccstudio",
        kind: "ccstudio",
        rawLine: "  102 /Applications/ti/ccs/ccstudio"
      }
    ]);
    expect(result.xdsdfuPath).toBe("/Applications/ti/ccs2100/ccs/ccs_base/common/uscif/xds110/xdsdfu");
  });

  test("includes parent process and elapsed runtime for possible debug owners", async () => {
    const result = await runHardwarePreflight({
      execFile: async (command, args) => {
        if (command.endsWith("/xdsdfu") && args[0] === "-e") {
          return { stdout: xdsdfuOutput, stderr: "" };
        }
        if (command === "ps") {
          expect(args).toEqual(["-axo", "pid=,ppid=,etime=,command="]);
          return {
            stdout: "93717 93710 18:57:01 ./DSLite\n48891 1 02:00:00 /bin/zsh",
            stderr: ""
          };
        }
        throw new Error(`unexpected command: ${command}`);
      }
    });

    expect(result.debugProcesses).toEqual(["93717 93710 18:57:01 ./DSLite"]);
    expect(result.debugProcessDetails).toEqual([
      {
        pid: 93717,
        ppid: 93710,
        elapsed: "18:57:01",
        command: "./DSLite",
        kind: "DSLite",
        rawLine: "93717 93710 18:57:01 ./DSLite"
      }
    ]);
  });

  test("does not treat shell commands that mention debug executable names as debug owners", async () => {
    const result = await runHardwarePreflight({
      execFile: async (command, args) => {
        if (command.endsWith("/xdsdfu") && args[0] === "-e") {
          return { stdout: xdsdfuOutput, stderr: "" };
        }
        if (command === "ps") {
          return {
            stdout: [
              "3404 48891 00:05 /bin/zsh -lc rg 'DSLite|DebugServer' /tmp/c2000-host.log",
              "93717 93710 18:57:01 ./DSLite"
            ].join("\n"),
            stderr: ""
          };
        }
        throw new Error(`unexpected command: ${command}`);
      }
    });

    expect(result.debugProcesses).toEqual(["93717 93710 18:57:01 ./DSLite"]);
    expect(result.debugProcessDetails).toEqual([
      {
        pid: 93717,
        ppid: 93710,
        elapsed: "18:57:01",
        command: "./DSLite",
        kind: "DSLite",
        rawLine: "93717 93710 18:57:01 ./DSLite"
      }
    ]);
  });

  test("returns a structured xdsdfu failure without throwing", async () => {
    const result = await runHardwarePreflight({
      execFile: async command => {
        if (command.endsWith("/xdsdfu")) {
          throw new Error("xdsdfu failed");
        }
        return { stdout: "", stderr: "" };
      }
    });

    expect(result.xdsdfu).toEqual(expect.objectContaining({
      ok: false,
      error: "xdsdfu failed"
    }));
    expect(result.debugProcesses).toEqual([]);
    expect(result.debugProcessDetails).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import { defaultCcsInstallPath, resolveXdsdfuPath, runHardwarePreflight } from "../src/hardware/preflight.js";

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
  test("resolves the platform-native XDS110 executable path", () => {
    expect(defaultCcsInstallPath("darwin")).toBe("/Applications/ti/ccs2100/ccs");
    expect(defaultCcsInstallPath("win32")).toBe("C:\\ti\\ccs2100\\ccs");
    expect(resolveXdsdfuPath("/Applications/ti/ccs2100/ccs", "darwin")).toBe(
      "/Applications/ti/ccs2100/ccs/ccs_base/common/uscif/xds110/xdsdfu"
    );
    expect(resolveXdsdfuPath("D:\\ccs21.0\\ccs", "win32")).toBe(
      "D:\\ccs21.0\\ccs\\ccs_base\\common\\uscif\\xds110\\xdsdfu.exe"
    );
  });

  test("enumerates XDS110 devices and filters possible debug owners", async () => {
    const result = await runHardwarePreflight({
      ccsInstallPath: "/Applications/ti/ccs2100/ccs",
      platform: "darwin",
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
      platform: "darwin",
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
      platform: "darwin",
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
      platform: "darwin",
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

  test("uses Windows process inspection and identifies an MCP-owned DSS Java process", async () => {
    const result = await runHardwarePreflight({
      ccsInstallPath: "D:\\ccs21.0\\ccs",
      platform: "win32",
      execFile: async (command, args) => {
        if (command.endsWith("xdsdfu.exe") && args[0] === "-e") {
          return { stdout: xdsdfuOutput, stderr: "" };
        }
        expect(command).toBe("powershell.exe");
        expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
        return {
          stdout: '54536 1200 00:00:00 "C:\\Program Files\\Java\\bin\\java.exe" c2000-persistent-server.js C:\\Temp\\c2000-dss-server-123\\server-config.json',
          stderr: ""
        };
      }
    });

    expect(result.processInspection).toEqual({ ok: true, platform: "win32" });
    expect(result.debugProcessDetails).toEqual([
      expect.objectContaining({ pid: 54536, ppid: 1200, kind: "c2000-dss" })
    ]);
  });

  test("ignores CCS renderer/backend helpers while retaining the main UI and DSLite owner", async () => {
    const result = await runHardwarePreflight({
      ccsInstallPath: "D:\\ccs21.0\\ccs",
      platform: "win32",
      execFile: async (command, args) => {
        if (command.endsWith("xdsdfu.exe") && args[0] === "-e") {
          return { stdout: xdsdfuOutput, stderr: "" };
        }
        return {
          stdout: [
            '18156 6388 00:05:00 "D:\\ccs21.0\\ccs\\theia\\ccstudio.exe"',
            '11604 18156 00:04:59 "D:\\ccs21.0\\ccs\\theia\\ccstudio.exe" --type=gpu-process',
            '58748 18156 00:04:58 D:\\ccs21.0\\ccs\\theia\\ccstudio.exe D:\\ccs21.0\\ccs\\theia\\resources\\app.asar\\lib\\backend\\main.js',
            '4944 57484 183:12:07 D:\\ccs21.0\\ccs\\ccs_base\\DebugServer\\bin\\DSLite.exe'
          ].join("\n"),
          stderr: ""
        };
      }
    });

    expect(result.debugProcessDetails.map(process => ({ pid: process.pid, kind: process.kind, elapsed: process.elapsed }))).toEqual([
      { pid: 18156, kind: "ccstudio", elapsed: "00:05:00" },
      { pid: 4944, kind: "DSLite", elapsed: "183:12:07" }
    ]);
  });

  test("retries a successful but empty enumeration and reports probe readiness separately", async () => {
    let enumerations = 0;
    const result = await runHardwarePreflight({
      platform: "darwin",
      enumerationAttempts: 3,
      sleep: async () => undefined,
      execFile: async command => {
        if (command.endsWith("/xdsdfu")) {
          enumerations += 1;
          return { stdout: enumerations === 1 ? "Found 0 devices." : xdsdfuOutput, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }
    });

    expect(enumerations).toBe(2);
    expect(result.xdsdfu).toEqual(expect.objectContaining({
      ok: true,
      commandOk: true,
      probeReady: true,
      attempts: 2
    }));
  });

  test("reports command success without claiming readiness when no probe appears", async () => {
    const result = await runHardwarePreflight({
      platform: "darwin",
      enumerationAttempts: 2,
      sleep: async () => undefined,
      execFile: async command => command.endsWith("/xdsdfu")
        ? { stdout: "Found 0 devices.", stderr: "" }
        : { stdout: "", stderr: "" }
    });

    expect(result.xdsdfu).toEqual(expect.objectContaining({
      ok: true,
      commandOk: true,
      probeReady: false,
      attempts: 2,
      devices: []
    }));
  });
});

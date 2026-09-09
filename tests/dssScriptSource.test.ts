import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { dssCommandScriptSource, dssLaunchArguments, resolveDssJson2Path, resolveDssLaunch, resolveDssScriptPath } from "../src/adapters/CcsScriptingBridge.js";
import { persistentServerScriptSource } from "../src/adapters/PersistentDssBridge.js";

const execFileAsync = promisify(execFile);

describe("DSS generated scripts", () => {
  test("resolves Windows DSS paths and environment with native separators", () => {
    const ccsRoot = "D:\\ccs21.0\\ccs";
    const dssScriptPath = resolveDssScriptPath(ccsRoot, "win32");
    const launch = resolveDssLaunch(dssScriptPath, ccsRoot, "win32");

    expect(dssScriptPath).toBe("D:\\ccs21.0\\ccs\\ccs_base\\scripting\\bin\\dss.bat");
    expect(resolveDssJson2Path(ccsRoot, "win32")).toBe(
      "D:\\ccs21.0\\ccs\\ccs_base\\scripting\\examples\\TestServer\\json2.js"
    );
    expect(launch.command.toLowerCase()).toContain("cmd.exe");
    expect(launch.args).toEqual(["/d", "/s", "/c"]);
    expect(launch.windowsBatch).toBe(true);
    expect(launch.windowsBatchScript).toBe(dssScriptPath);
    expect(dssLaunchArguments(launch, ["D:\\Temp\\command.js", "D:\\Temp\\command.json"])).toEqual([
      "/d", "/s", "/c", "call", dssScriptPath, "D:\\Temp\\command.js", "D:\\Temp\\command.json"
    ]);
    expect(launch.env?.PATH).toContain(";");
    expect(launch.env?.DYLD_LIBRARY_PATH).toBeUndefined();
  });

  test("quotes safe Windows paths with spaces as one cmd.exe command argument", () => {
    const dssScriptPath = "C:\\Program Files\\TI\\dss.bat";
    const launch = resolveDssLaunch(dssScriptPath, "C:\\Program Files\\TI", "win32");

    expect(dssLaunchArguments(launch, ["C:\\Temp Files\\command.js"])).toEqual([
      "/d", "/s", "/c", "call", dssScriptPath, "C:\\Temp Files\\command.js"
    ]);
  });

  test("launches the x86_64 DSS tool through Rosetta on Apple Silicon", () => {
    const dssScriptPath = "/Applications/ti/ccs2100/ccs/ccs_base/scripting/bin/dss.sh";
    const launch = resolveDssLaunch(dssScriptPath, "/Applications/ti/ccs2100/ccs", "darwin", "arm64");

    expect(launch.command).toBe("arch");
    expect(launch.args).toEqual(["-x86_64", dssScriptPath]);
  });

  test("starts a Windows batch launcher with spaced script and config paths", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-dss-windows-launch-"));
    const dssScriptPath = path.join(tempDir, "fake dss.bat");
    const commandScriptPath = path.join(tempDir, "server script.js");
    const commandConfigPath = path.join(tempDir, "server config.json");
    try {
      await writeFile(
        dssScriptPath,
        ["@echo off", "echo __C2000_DSS_ARGS__%~1^|%~2", "exit /b 0"].join("\r\n"),
        "utf8"
      );
      const launch = resolveDssLaunch(dssScriptPath, tempDir, "win32");
      const { stdout, stderr } = await execFileAsync(
        launch.command,
        dssLaunchArguments(launch, [commandScriptPath, commandConfigPath]),
        { env: launch.env, windowsHide: true }
      );

      expect(stderr).toBe("");
      expect(stdout).toContain(`__C2000_DSS_ARGS__${commandScriptPath}|${commandConfigPath}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects Windows DSS paths that could alter cmd.exe parsing", () => {
    try {
      resolveDssLaunch("D:\\ccs & whoami\\dss.bat", "D:\\ccs", "win32");
      throw new Error("unsafe path should have been rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "UnsafeDssLaunchPath" });
    }
  });

  test("load json2.js by absolute path before using JSON", () => {
    const json2Path = resolveDssJson2Path("/Applications/ti/ccs2100/ccs");
    const escapedJson2Path = json2Path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    expect(dssCommandScriptSource(json2Path)).toContain(`load("${escapedJson2Path}");`);
    expect(persistentServerScriptSource(json2Path)).toContain(`load("${escapedJson2Path}");`);
  });

  test("DSS getState reports Disconnected before evaluating run or halt state", () => {
    const statelessSource = dssCommandScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));
    const persistentSource = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    for (const source of [statelessSource, persistentSource]) {
      expect(source).toContain("var connected = ");
      expect(source).toContain('var state = connected ?');
      expect(source).toContain(': "Disconnected"');
      expect(source).not.toContain('state: "Unknown"');
    }

    const statusBlocks = [
      [statelessSource, 'command.operation === "getState"', 'command.operation === "evaluateExpression"'],
      [persistentSource, 'command.name === "getState"', 'command.name === "resolveAddress"']
    ] as const;
    for (const [source, startToken, endToken] of statusBlocks) {
      const start = source.indexOf(startToken);
      const end = source.indexOf(endToken, start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(source.slice(start, end)).not.toContain('evaluate("PC")');
    }
  });

  test("persistent DSS server registers cleanup for per-core DebugSessions and DebugServer", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("function cleanupPersistentDebugServer()");
    expect(source).toContain("sessions[cleanupIndex].terminate()");
    expect(source).toContain("debugServer.stop()");
    expect(source).toContain("importClass(java.lang.Runtime)");
    expect(source).toContain("Runtime.getRuntime().addShutdownHook");
    expect(source).toContain("cleanupPersistentDebugServer()");
  });

  test("persistent DSS server configures F28P65x Flash mapping, clock, and selected erase banks", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain('command.name === "prepareFlashLoad"');
    expect(source).toContain('flash.options.setString("FlashMapC28Bank"');
    expect(source).toContain('flash.options.setString("FlashEraseSelection", "Selected Banks Only")');
    expect(source).toContain('flash.performOperation("ConfigureClock")');
    expect(source).toContain('flash.performOperation("ConfigureBanks")');
  });

  test("persistent DSS server resolves every command through coreId to DebugSession mapping", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("var sessionsByCoreId = {};");
    expect(source).toContain("sessionsByCoreId[String(core.coreId)] = session;");
    expect(source).toContain("function getSessionForCommand(command)");
    expect(source).toContain("var session = getSessionForCommand(command);");
    expect(source).not.toContain("function handleCommand(session, command)");
    expect(source).not.toContain("writeResponse(output, handleCommand(session, command))");
  });

  test("persistent DSS server rejects commands whose coreId does not match the bound core socket", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("function startCoreThread(port, boundCoreId)");
    expect(source).toContain("if (command.name !== \"shutdown\" && String(command.coreId) !== String(boundCoreId))");
    expect(source).toContain('message: "Command coreId does not match bound core socket"');
    expect(source).toContain("boundCoreId: boundCoreId");
    expect(source).toContain("commandCoreId: command.coreId");
    expect(source).toContain("threads.push(startCoreThread(config.basePort + i, core.coreId));");
  });

  test("persistent DSS server rejects commands whose coreName does not match the bound core mapping", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("var coreNamesByCoreId = {};");
    expect(source).toContain("coreNamesByCoreId[String(core.coreId)] = core.coreName;");
    expect(source).toContain("var boundCoreName = coreNamesByCoreId[String(boundCoreId)];");
    expect(source).toContain("if (command.name !== \"shutdown\" && command.coreName !== boundCoreName)");
    expect(source).toContain('message: "Command coreName does not match bound core socket"');
    expect(source).toContain("boundCoreName: boundCoreName");
    expect(source).toContain("commandCoreName: command.coreName");
  });

  test("persistent DSS server includes requested core identity in every per-core response", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("function withCoreIdentity(command, value)");
    expect(source).toContain("result.coreId = command.coreId;");
    expect(source).toContain("result.coreName = command.coreName;");
    for (const commandName of ["connect", "disconnect", "runAsynch", "halt", "reset", "load", "writeData", "evaluateExpression", "assignExpression", "getState", "resolveAddress"]) {
      expect(source).toContain(`return { status: "OK", value: withCoreIdentity(command,`);
      expect(source).toContain(`command.name === "${commandName}"`);
    }
  });

  test("persistent DSS server writes explicit data memory through the bound core DebugSession", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain('command.name === "writeData"');
    expect(source).toContain("session.memory.writeData(resolveMemoryPage(command.page), command.address, command.value, command.typeSize)");
    expect(source).toContain('command.name === "readData"');
    expect(source).toContain("session.memory.readData(resolveMemoryPage(command.page), command.address, command.typeSize)");
    expect(source).toContain("function resolveMemoryPage(page)");
    expect(source).toContain("return Memory.Page.DATA");
  });

  test("DSS scripts apply resetType-aware reset helpers and report resolveAddress as partial", () => {
    const statelessSource = dssCommandScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));
    const persistentSource = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    for (const source of [statelessSource, persistentSource]) {
      expect(source).toContain("function applyTargetReset(session, resetType)");
      expect(source).toContain('type === "system"');
      expect(source).toContain('if (type === "restart")');
      expect(source).toContain("session.target.reset()");
      expect(source).toContain("Address-to-source mapping is not implemented");
      expect(source).toContain("partial: true");
      expect(source).toContain("success: false");
    }
  });

  test("stateless DSS command script includes requested core identity in every successful result", () => {
    const source = dssCommandScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("function withCoreIdentity(command, value)");
    expect(source).toContain("result.coreId = command.coreId;");
    expect(source).toContain("result.coreName = command.coreName;");
    expect(source).toContain("printResult(withCoreIdentity(command, result));");
    expect(source).not.toContain("printResult(result);");
  });

  test("persistent DSS server supports an explicit shutdown command", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain('if (command.name === "shutdown")');
    expect(source).toContain("var shouldShutdown = command.name === \"shutdown\"");
    expect(source).toContain("cleanupPersistentDebugServer()");
    expect(source).toContain("java.lang.System.exit(0)");
  });

  test("persistent DSS server binds its configured host and authenticates every command", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("importClass(java.net.InetSocketAddress);");
    expect(source).toContain("var socket = new ServerSocket();");
    expect(source).toContain('socket.bind(new InetSocketAddress(String(config.host || "127.0.0.1"), port));');
    expect(source).toContain("function isAuthenticated(command)");
    expect(source).toContain("command.authToken === String(config.authToken)");
    expect(source).toContain('message: "Unauthorized DSS command"');
    expect(source).toContain("if (!isAuthenticated(command))");
  });

  test("persistent DSS server logs command lifecycle events to stderr", () => {
    const source = persistentServerScriptSource(resolveDssJson2Path("/Applications/ti/ccs2100/ccs"));

    expect(source).toContain("function logDiagnostic(event, details)");
    expect(source).toContain('java.lang.System.err.println("C2000_DSS_SERVER_EVENT " + JSON.stringify(payload));');
    expect(source).toContain('logDiagnostic("command:start"');
    expect(source).toContain('logDiagnostic("command:success"');
    expect(source).toContain('logDiagnostic("command:failure"');
    expect(source).toContain("boundCoreId: boundCoreId");
    expect(source).toContain("commandName: command.name");
  });
});

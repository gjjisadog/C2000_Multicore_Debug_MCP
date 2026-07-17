import { describe, expect, test } from "vitest";
import { dssCommandScriptSource, resolveDssJson2Path } from "../src/adapters/CcsScriptingBridge.js";
import { persistentServerScriptSource } from "../src/adapters/PersistentDssBridge.js";

describe("DSS generated scripts", () => {
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
      expect(source).toContain('if (type === "system")');
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

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { MockDebugAdapter } from "../src/adapters/MockDebugAdapter.js";
import type { AdapterSession } from "../src/adapters/types.js";
import { DebugSessionManager } from "../src/debug/DebugSessionManager.js";
import { LoadedProgramRegistry } from "../src/debug/LoadedProgramRegistry.js";
import type { CoreId, ResetType } from "../src/debug/types.js";
import { createToolHandlers } from "../src/mcp/toolHandlers.js";

const coreMap = [
  { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
  { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2" }
];

function serialBoundCcxml(serial: string, debugProbeSelection = "0"): string {
  return `<configurations>
  <property Type="choicelist" Value="${debugProbeSelection}" id="Debug Probe Selection">
    <choice Name="Select by serial number" value="0">
      <property Type="stringfield" Value="${serial}" id="-- Enter the serial number"/>
    </choice>
  </property>
</configurations>`;
}

const hybrid30kReadyExpressionValues = {
  "g_stCoreCommCpu1Watch.emStage": { value: "5" },
  "g_stCoreCommCpu1Watch.ulIpcPass": { value: "1" },
  "g_stCoreCommCpu1Watch.ulCpu2Ready": { value: "1" },
  "g_stCoreCommCpu1Watch.ulCpu2BootLastError": { value: "0" },
  "g_stCoreCommCpu2Watch.emStage": { value: "5" },
  "g_stCoreCommCpu2Watch.ulInitialParameterSnapshotSeq": { value: "1" },
  "g_stCoreCommCpu2Watch.ulInitialParameterApplied": { value: "1" }
};

function createHandlers(adapter = new MockDebugAdapter()) {
  const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
  return createToolHandlers(manager);
}

class CountingAdapter extends MockDebugAdapter {
  createSessionCount = 0;

  override async createSession(options: Parameters<MockDebugAdapter["createSession"]>[0]) {
    this.createSessionCount += 1;
    return super.createSession(options);
  }
}

class WorkflowRecordingAdapter extends MockDebugAdapter {
  readonly events: string[] = [];

  override async connect(session: AdapterSession, coreId: CoreId): Promise<void> {
    this.events.push(`connect:${coreId}`);
    await super.connect(session, coreId);
  }

  override async halt(session: AdapterSession, coreId: CoreId): Promise<void> {
    this.events.push(`halt:${coreId}`);
    await super.halt(session, coreId);
  }

  override async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<void> {
    this.events.push(`reset:${coreId}:${resetType}`);
    await super.reset(session, coreId, resetType);
  }

  override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
    this.events.push(`load:${coreId}:${path.basename(programUri)}`);
    await super.loadProgram(session, coreId, programUri);
  }

  override async run(session: AdapterSession, coreId: CoreId): Promise<void> {
    this.events.push(`run:${coreId}`);
    await super.run(session, coreId);
  }
}

class Cpu2LoadFailureAdapter extends WorkflowRecordingAdapter {
  override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
    this.events.push(`load:${coreId}:${path.basename(programUri)}`);
    if (coreId === 2) {
      throw new Error("simulated CPU2 load failure");
    }
    await MockDebugAdapter.prototype.loadProgram.call(this, session, coreId, programUri);
  }
}

type CriticalBatchStage = "initialHalt" | "reset" | "postLoadHalt";

class CriticalBatchFailureAdapter extends WorkflowRecordingAdapter {
  private haltCount = 0;

  constructor(private readonly stage: CriticalBatchStage) {
    super();
  }

  override async halt(session: AdapterSession, coreId: CoreId): Promise<void> {
    this.haltCount += 1;
    this.events.push(`halt:${coreId}`);
    const isFailingHalt = coreId === 2
      && ((this.stage === "initialHalt" && this.haltCount === 2)
        || (this.stage === "postLoadHalt" && this.haltCount === 4));
    if (isFailingHalt) {
      throw new Error(`simulated ${this.stage} failure`);
    }
    await MockDebugAdapter.prototype.halt.call(this, session, coreId);
  }

  override async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<void> {
    this.events.push(`reset:${coreId}:${resetType}`);
    if (this.stage === "reset" && coreId === 2) {
      throw new Error("simulated reset failure");
    }
    await MockDebugAdapter.prototype.reset.call(this, session, coreId, resetType);
  }
}

class OwnershipMismatchAdapter extends MockDebugAdapter {
  override async readMemory(
    session: AdapterSession,
    coreId: CoreId,
    page: string,
    address: number,
    typeSize: number
  ): Promise<number> {
    await super.readMemory(session, coreId, page, address, typeSize);
    return 0;
  }
}

class OwnershipMismatchRecordingAdapter extends WorkflowRecordingAdapter {
  override async readMemory(
    session: AdapterSession,
    coreId: CoreId,
    page: string,
    address: number,
    typeSize: number
  ): Promise<number> {
    await super.readMemory(session, coreId, page, address, typeSize);
    return 0;
  }
}

describe("tool handlers", () => {
  test("getToolContracts returns injected scope metadata", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      getToolContracts: () => [
        {
          name: "c2000_continue",
          inputScope: "core",
          inputFields: ["sessionId", "coreId"],
          requiredInputFields: ["sessionId", "coreId"]
        }
      ]
    });

    const result = await handlers.getToolContracts({});

    expect(result).toEqual(expect.objectContaining({
      success: true,
      tools: [
        expect.objectContaining({
          name: "c2000_continue",
          inputScope: "core",
          requiredInputFields: ["sessionId", "coreId"]
        })
      ],
      toolSurface: expect.any(Object)
    }));
  });

  test("getHardwarePreflight returns read-only XDS110 and debug process status", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      runHardwarePreflight: async (options = {}) => ({
        xdsdfuPath: `${options.ccsInstallPath}/ccs_base/common/uscif/xds110/xdsdfu`,
        xdsdfu: {
          ok: true,
          stdout: "xdsdfu output",
          stderr: "",
          devices: [
            { serialNumber: "CL650001", mode: "Runtime", configuration: "Standard", version: "3.0.0.43", name: "XDS110" }
          ]
        },
        debugProcesses: ["93717 ./DSLite"],
        debugProcessDetails: [{ pid: 93717, ppid: 93710, elapsed: "18:57:01", command: "./DSLite", kind: "DSLite", rawLine: "93717 ./DSLite" }]
      })
    });

    const result = await handlers.getHardwarePreflight({ ccsInstallPath: "/Applications/ti/ccs2100/ccs" });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      xdsdfuPath: "/Applications/ti/ccs2100/ccs/ccs_base/common/uscif/xds110/xdsdfu",
      xdsdfu: expect.objectContaining({
        ok: true,
        devices: [expect.objectContaining({ serialNumber: "CL650001", mode: "Runtime" })]
      }),
      debugProcesses: ["93717 ./DSLite"],
      debugProcessDetails: [{ pid: 93717, ppid: 93710, elapsed: "18:57:01", command: "./DSLite", kind: "DSLite", rawLine: "93717 ./DSLite" }]
    }));
  });

  test("getAcceptanceEvidence returns the final acceptance proof plan without touching debug sessions", async () => {
    const adapter = new CountingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.getAcceptanceEvidence({});

    expect(result).toEqual(expect.objectContaining({
      success: true,
      evidence: "c2000_multicore_acceptance_evidence_plan",
      hostReadinessTool: "c2000_getAcceptanceReadiness",
      hardwareAcceptanceTool: "c2000_verifyRunPauseIsolation",
      requirements: expect.arrayContaining([
        expect.objectContaining({
          id: "continue_cpu1_only",
          proofTool: "c2000_verifyRunPauseIsolation",
          proofLabel: "c2000_continue(cpu1)",
          requiredInputs: ["sessionId", "coreId"],
          checkedCommandFields: ["coreId", "coreName"],
          checkedPeerFields: ["connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
        }),
        expect.objectContaining({
          id: "multicore_snapshot",
          proofTool: "c2000_getMulticoreSnapshot",
          requiredInputs: ["sessionId"],
          expectedCoreFields: ["coreName", "connected", "state", "pc", "loadedProgram", "loadedProgramInfo"]
        }),
        expect.objectContaining({
          id: "debug_tool_contracts",
          proofTool: "c2000_getToolContracts",
          expectedCoreDebugTools: [
            "c2000_connectTarget",
            "c2000_disconnectTarget",
            "c2000_runCore",
            "c2000_continue",
            "c2000_haltCore",
            "c2000_pause",
            "c2000_reset",
            "c2000_getTargetState",
            "c2000_loadProgram"
          ],
          expectedRequiredInputs: ["sessionId", "coreId"],
          expectedResponseCoreIdentityFields: ["coreId", "coreName"]
        }),
        expect.objectContaining({
          id: "multicore_tool_contracts",
          proofTool: "c2000_getToolContracts",
          expectedMulticoreToolContracts: expect.arrayContaining([
            expect.objectContaining({
              name: "c2000_loadPrograms",
              inputScope: "batch",
              requiredInputFields: ["sessionId", "programs"],
              coreIdentityFields: ["programs[].coreId"],
              responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
            }),
            expect.objectContaining({
              name: "c2000_getMulticoreSnapshot",
              inputScope: "session",
              requiredInputFields: ["sessionId"],
              coreIdentityFields: ["coreIds[]"],
              responseCoreIdentityFields: ["cores[].coreId", "cores[].coreName"]
            })
          ])
        }),
        expect.objectContaining({
          id: "advanced_automation_contracts",
          proofTool: "c2000_getToolContracts",
          expectedAdvancedAutomationToolContracts: expect.arrayContaining([
            expect.objectContaining({
              name: "c2000_assignExpressions",
              inputScope: "batch",
              targetEffect: "memory-write",
              requiredInputFields: ["sessionId", "assignments"],
              coreIdentityFields: ["assignments[].coreId"],
              responseCoreIdentityFields: ["results[].coreId", "results[].coreName"]
            }),
            expect.objectContaining({
              name: "c2000_compareExpressions",
              inputScope: "session",
              targetEffect: "target-read",
              requiredInputFields: ["sessionId", "comparisons"],
              coreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"],
              responseCoreIdentityFields: ["comparisons[].left.coreId", "comparisons[].right.coreId"]
            }),
            expect.objectContaining({
              name: "c2000_diagnoseCpu2Boot",
              inputScope: "session",
              targetEffect: "target-read",
              requiredInputFields: ["sessionId", "cpu1CoreId", "cpu2CoreId"],
              coreIdentityFields: ["cpu1CoreId", "cpu2CoreId"],
              responseCoreIdentityFields: ["cpu1.coreId", "cpu2.coreId", "snapshot.cores[].coreId"]
            }),
            expect.objectContaining({
              name: "c2000_launchMulticoreDebug",
              inputScope: "launch",
              targetEffect: "launch-workflow",
              requiredInputFields: ["cores"],
              coreIdentityFields: expect.arrayContaining([
                "cores[].coreId",
                "postLaunchChecks.diagnoseCpu2Boot.cpu1CoreId",
                "postLaunchChecks.diagnoseCpu2Boot.cpu2CoreId"
              ]),
              responseCoreIdentityFields: expect.arrayContaining(["snapshot.cores[].coreId"])
            })
          ])
        }),
        expect.objectContaining({
          id: "no_ccs_ui_focus",
          evidenceField: "uiIndependenceEvidence",
          expectedEvidence: expect.objectContaining({
            officialTiMcpDebugControlsUsed: false,
            activeTargetAllowed: false,
            uiFocusRequired: false,
            selectedCpuRequired: false
          })
        })
      ])
    }));
    expect(adapter.createSessionCount).toBe(0);
  });

  test("discoverAcceptancePrograms returns read-only CPU1 and CPU2 .out discovery", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      discoverAcceptancePrograms: async (options = {}) => ({
        searchRoots: options.searchRoots ?? [],
        cpu1: {
          selected: options.cpu1Program ?? "/workspace/cpu1.out",
          source: options.cpu1Program ? "env" : "discovered",
          candidates: [options.cpu1Program ?? "/workspace/cpu1.out"]
        },
        cpu2: {
          selected: options.cpu2Program ?? "/workspace/cpu2.out",
          source: options.cpu2Program ? "env" : "discovered",
          candidates: [options.cpu2Program ?? "/workspace/cpu2.out"]
        }
      })
    });

    const result = await handlers.discoverAcceptancePrograms({
      cpu1Program: "/explicit/cpu1.out",
      searchRoots: ["/workspace"],
      maxDepth: 4
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      searchRoots: ["/workspace"],
      cpu1: expect.objectContaining({
        selected: "/explicit/cpu1.out",
        source: "env",
        candidates: ["/explicit/cpu1.out"]
      }),
      cpu2: expect.objectContaining({
        selected: "/workspace/cpu2.out",
        source: "discovered",
        candidates: ["/workspace/cpu2.out"]
      })
    }));
  });

  test("analyzeRamOwnership parses CPU2 map files without touching debug sessions", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-map-tool-"));
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2Map, [
      "MEMORY CONFIGURATION",
      "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX",
      "SECTION ALLOCATION MAP",
      ".text      0    00018000    000007bc"
    ].join("\n"));
    const adapter = new CountingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.analyzeRamOwnership({
      maps: [{ coreId: 2, coreName: "C28xx_CPU2", mapPath: cpu2Map }]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      ownershipActions: [
        expect.objectContaining({ ownerCoreId: 0, targetCoreId: 2, memoryRegion: "RAMGS4", value: 0x10 })
      ]
    }));
    expect(adapter.createSessionCount).toBe(0);
  });

  test("diagnoseBootHandoff combines boot diagnostics with RAM ownership evidence", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-boot-handoff-"));
    const cpu2Map = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2Map, [
      "MEMORY CONFIGURATION",
      "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX",
      "SECTION ALLOCATION MAP",
      ".text      0    00018000    000007bc"
    ].join("\n"));
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: hybrid30kReadyExpressionValues
    }));
    const created = await handlers.createDebugSession({ sessionName: "boot-handoff", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.diagnoseBootHandoff({
      sessionId: created.sessionId,
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      maps: [{ coreId: 2, coreName: "C28xx_CPU2", mapPath: cpu2Map }]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      cpu1: expect.objectContaining({ coreId: 0 }),
      cpu2: expect.objectContaining({ coreId: 2 }),
      verdict: expect.objectContaining({ cpu1Ready: true, cpu2Ready: true, ramOwnershipReady: true, ready: true }),
      ramOwnership: expect.objectContaining({
        ownershipActions: [expect.objectContaining({ targetCoreId: 2, memoryRegion: "RAMGS4" })]
      })
    }));
  });

  test("diagnoseBootHandoff requires explicit CPU core IDs", async () => {
    const handlers = createHandlers(new MockDebugAdapter());
    const created = await handlers.createDebugSession({ sessionName: "boot-handoff-explicit", coreMap });

    const result = await handlers.diagnoseBootHandoff({
      sessionId: created.sessionId
    } as any);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        message: expect.stringContaining("cpu1CoreId")
      })
    }));
  });

  test("waitForIpcReady uses default explicit CPU1 and CPU2 ready conditions", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        ...hybrid30kReadyExpressionValues,
        "g_stCoreCommCpu1Watch.ulMsgRamPass": { value: "0" },
        "g_stCoreCommCpu1Watch.ulParamPass": { value: "0" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "ipc-ready", coreMap });

    const result = await handlers.waitForIpcReady({
      sessionId: created.sessionId,
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      timeoutMs: 10,
      intervalMs: 1
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      matched: true,
      conditions: expect.arrayContaining([
        expect.objectContaining({ coreId: 0, expression: "g_stCoreCommCpu1Watch.ulIpcPass", matched: true }),
        expect.objectContaining({ coreId: 2, expression: "g_stCoreCommCpu2Watch.emStage", matched: true })
      ])
    }));
    expect(result.conditions).toHaveLength(7);
    expect(result.conditions.map((condition: { expression: string }) => condition.expression)).not.toEqual(
      expect.arrayContaining([
        "g_stCoreCommCpu1Watch.ulMsgRamPass",
        "g_stCoreCommCpu1Watch.ulParamPass"
      ])
    );
  });

  test("reloadResetRunToMain performs supported per-core reload reset run steps and reports run-to-main limitation", async () => {
    class RecordingAdapter extends MockDebugAdapter {
      readonly events: string[] = [];

      override async loadProgram(session: AdapterSession, coreId: CoreId, programUri: string): Promise<void> {
        this.events.push(`load:${coreId}:${programUri}`);
        await super.loadProgram(session, coreId, programUri);
      }

      override async reset(session: AdapterSession, coreId: CoreId, resetType: ResetType): Promise<void> {
        this.events.push(`reset:${coreId}:${resetType}`);
        await super.reset(session, coreId, resetType);
      }

      override async run(session: AdapterSession, coreId: CoreId): Promise<void> {
        this.events.push(`run:${coreId}`);
        await super.run(session, coreId);
      }
    }
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-reload-"));
    const programUri = path.join(tempDir, "cpu1.out");
    await writeFile(programUri, "cpu1-image");
    const adapter = new RecordingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "reload-reset-run", coreMap });
    await handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 });

    const result = await handlers.reloadResetRunToMain({
      sessionId: created.sessionId,
      coreId: 0,
      programUri,
      resetType: "cpu"
    });

    expect(adapter.events).toEqual([
      `load:0:${programUri}`,
      "reset:0:cpu",
      "run:0"
    ]);
    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      coreId: 0,
      coreName: "C28xx_CPU1",
      runToMainSupported: false,
      runToMainAchieved: false,
      unsupportedReason: expect.stringContaining("breakpoint"),
      finalState: expect.objectContaining({ coreId: 0, state: "Running" })
    }));
  });

  test("runIpcAcceptance performs the full server-side workflow in one handler call", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-ipc-workflow-"));
    const outputDir = path.join(tempDir, "bundle");
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu1MapPath = path.join(tempDir, "cpu1.map");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu1MapPath, "MEMORY CONFIGURATION\n  RAMLS0                00008000   00000800  00000010  000007f0  RWIX\n");
    await writeFile(cpu2MapPath, [
      "MEMORY CONFIGURATION",
      "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX",
      "SECTION ALLOCATION MAP",
      ".text      0    00018000    000007bc"
    ].join("\n"));
    const adapter = new OwnershipMismatchRecordingAdapter({
      expressionValues: {
        "customCpu1.ipcPass": { value: "1" },
        "customCpu1.msgRamPass": { value: "1" },
        "customCpu1.paramPass": { value: "1" },
        "customCpu2.stage": { value: "5" }
      }
    });
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry(), undefined, {
      defaultWorkspacePath: tempDir
    });
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "ipc-acceptance-workflow", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    adapter.events.length = 0;

    const result = await handlers.runIpcAcceptance({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: path.basename(cpu1OutPath),
      cpu2OutPath: path.basename(cpu2OutPath),
      cpu1MapPath: path.basename(cpu1MapPath),
      cpu2MapPath: path.basename(cpu2MapPath),
      resetType: "cpu",
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true },
      ipcReadyExpressions: [
        { label: "ipc", coreId: 0, expression: "customCpu1.ipcPass", expected: 1 },
        { label: "msgram", coreId: 0, expression: "customCpu1.msgRamPass", expected: 1 },
        { label: "param", coreId: 0, expression: "customCpu1.paramPass", expected: 1 },
        { label: "cpu2", coreId: 2, expression: "customCpu2.stage", expected: 5 }
      ],
      timeoutMs: 20,
      intervalMs: 1,
      verifyRuntimeRamOwnership: true,
      collectDebugBundle: true,
      outputDir
    });

    expect(adapter.events).toEqual([
      "halt:0",
      "halt:2",
      "reset:0:cpu",
      "reset:2:cpu",
      "load:0:cpu1.out",
      "load:2:cpu2.out",
      "halt:0",
      "halt:2",
      "run:0",
      "run:2"
    ]);
    expect(result).toEqual(expect.objectContaining({
      success: false,
      workflow: "c2000_runIpcAcceptance",
      orchestration: "server-internal",
      mcpToolCalls: [],
      sessionId: created.sessionId,
      runPlan: expect.objectContaining({ mode: "debugger_runs_both", coreOrder: [0, 2] }),
      ipcReady: expect.objectContaining({
        matched: true,
        conditions: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, expression: "customCpu1.ipcPass", matched: true }),
          expect.objectContaining({ coreId: 2, expression: "customCpu2.stage", matched: true })
        ])
      }),
      snapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, loadedProgram: cpu1OutPath }),
          expect.objectContaining({ coreId: 2, loadedProgram: cpu2OutPath })
        ])
      }),
      ramOwnership: expect.objectContaining({
        ownershipActions: [expect.objectContaining({ targetCoreId: 2, memoryRegion: "RAMGS4" })]
      }),
      elfFreshness: expect.objectContaining({
        allFresh: true,
        programs: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, fresh: true }),
          expect.objectContaining({ coreId: 2, fresh: true })
        ])
      }),
      diagnosis: expect.objectContaining({
        diagnosisCode: "IPC_ACCEPTANCE_NOT_READY",
        severity: "warning",
        cpu1: expect.objectContaining({ coreId: 0 }),
        cpu2: expect.objectContaining({ coreId: 2 }),
        verdict: expect.objectContaining({
          cpu1Ready: true,
          cpu2Ready: true,
          runtimeRamOwnershipReady: false,
          ready: false
        })
      }),
      runtimeRamOwnership: expect.objectContaining({ requested: true, matched: false }),
      debugBundle: expect.objectContaining({
        files: expect.arrayContaining([
          expect.stringContaining("summary.md"),
          expect.stringContaining("snapshot.json"),
          expect.stringContaining("evidence.json")
        ])
      })
    }));
  });

  test("runIpcAcceptance uses supplied IPC conditions without evaluating default Hybrid symbols", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-ipc-custom-condition-"));
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu1MapPath = path.join(tempDir, "cpu1.map");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu1MapPath, "MEMORY CONFIGURATION\n  RAMLS0                00008000   00000800  00000010  000007f0  RWIX\n");
    await writeFile(cpu2MapPath, "MEMORY CONFIGURATION\n  RAMGS4                00018000   00002000  00000871  0000178f  RWIX\n");
    const adapter = new WorkflowRecordingAdapter({
      expressionValues: { "ipc.responsePass": { value: "1" } }
    });
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry(), undefined, {
      defaultWorkspacePath: tempDir
    });
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "ipc-custom-condition", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.runIpcAcceptance({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath,
      cpu2OutPath,
      cpu1MapPath,
      cpu2MapPath,
      resetType: "cpu",
      runSequence: { runMode: "debugger_runs_both", runCpu1First: true, runCpu2: true },
      ipcReadyExpressions: [
        { label: "cpu1-response", coreId: 0, expression: "ipc.responsePass", expected: 1 }
      ],
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      diagnosis: expect.objectContaining({
        diagnosisCode: "IPC_ACCEPTANCE_READY",
        severity: "info",
        cpu1: expect.objectContaining({
          expressions: [expect.objectContaining({ expression: "ipc.responsePass", success: true, value: "1" })]
        }),
        cpu2: expect.objectContaining({ expressions: [] }),
        verdict: expect.objectContaining({
          ipcReady: true,
          readinessBasis: "matched-ipc-conditions",
          ramOwnershipReady: true,
          ready: true
        })
      })
    }));
  });

  test("launchMultiBoardDebug allocates each connected XDS110 to an isolated session", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-multiboard-"));
    const boardAConfig = path.join(tempDir, "board-a.ccxml");
    const boardBConfig = path.join(tempDir, "board-b.ccxml");
    await writeFile(boardAConfig, serialBoundCcxml("CL650001"));
    await writeFile(boardBConfig, serialBoundCcxml("CL650002"));
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      runHardwarePreflight: async () => ({
        xdsdfuPath: "xdsdfu",
        xdsdfu: {
          ok: true,
          commandOk: true,
          probeReady: true,
          devices: [
            { serialNumber: "CL650001", mode: "Runtime" },
            { serialNumber: "CL650002", mode: "Runtime" }
          ]
        },
        debugProcesses: [],
        debugProcessDetails: [],
        processInspection: { ok: true, platform: "win32" }
      })
    });

    const result = await handlers.launchMultiBoardDebug({
      boards: [
        {
          boardId: "board-a",
          probeSerial: "CL650001",
          ccxmlPath: boardAConfig,
          cores: coreMap.map(core => ({ ...core, connect: true, load: false, haltAtEntry: false }))
        },
        {
          boardId: "board-b",
          probeSerial: "CL650002",
          ccxmlPath: boardBConfig,
          cores: coreMap.map(core => ({ ...core, connect: true, load: false, haltAtEntry: false }))
        }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      allocationMode: "sequential-session-allocation",
      connectedProbeSerials: ["CL650001", "CL650002"],
      results: [
        expect.objectContaining({ boardId: "board-a", probeSerial: "CL650001", sessionId: expect.any(String) }),
        expect.objectContaining({ boardId: "board-b", probeSerial: "CL650002", sessionId: expect.any(String) })
      ]
    }));
    const sessionIds = result.results.map((item: { sessionId: string }) => item.sessionId);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
    await Promise.all(sessionIds.map((sessionId: string) => manager.closeDebugSession(sessionId)));
  });

  test("launchMultiBoardDebug connects and loads CPU1 first while preserving the CPU2 map", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-multiboard-cpu-order-"));
    const ccxmlPath = path.join(tempDir, "board.ccxml");
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(ccxmlPath, serialBoundCcxml("CL650001"));
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu2MapPath, "MEMORY CONFIGURATION\n  RAMGS5                0001A000   00002000  00000871  0000178f  RWIX\n");
    const adapter = new WorkflowRecordingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      runHardwarePreflight: async () => ({
        xdsdfuPath: "xdsdfu",
        xdsdfu: { ok: true, commandOk: true, probeReady: true, devices: [{ serialNumber: "CL650001", mode: "Runtime" }] },
        debugProcesses: [],
        debugProcessDetails: [],
        processInspection: { ok: true, platform: "win32" }
      })
    });

    const result = await handlers.launchMultiBoardDebug({
      boards: [{
        boardId: "board-a",
        probeSerial: "CL650001",
        ccxmlPath,
        cores: [...coreMap].reverse().map(core => ({
          ...core,
          connect: true,
          load: true,
          haltAtEntry: false,
          programUri: core.coreId === 0 ? cpu1OutPath : cpu2OutPath,
          ...(core.coreId === 2 ? { mapUri: cpu2MapPath } : {})
        }))
      }]
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(adapter.events).toEqual([
      "connect:0",
      "load:0:cpu1.out",
      "connect:2",
      "load:2:cpu2.out"
    ]);
    const sessionId = result.results[0].sessionId;
    await expect(manager.getLoadedProgramInfo(sessionId, 2)).resolves.toEqual(expect.objectContaining({ mapUri: cpu2MapPath }));
    await manager.closeDebugSession(sessionId);
  });

  test("launchMultiBoardDebug rejects a ccxml that contains a serial but does not select by serial number", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-invalid-binding-"));
    const ccxmlPath = path.join(tempDir, "invalid-binding.ccxml");
    await writeFile(ccxmlPath, serialBoundCcxml("CL650001", "1"));
    const adapter = new CountingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      runHardwarePreflight: async () => ({
        xdsdfuPath: "xdsdfu",
        xdsdfu: { ok: true, commandOk: true, probeReady: true, devices: [{ serialNumber: "CL650001", mode: "Runtime" }] },
        debugProcesses: [],
        debugProcessDetails: [],
        processInspection: { ok: true, platform: "win32" }
      })
    });

    const result = await handlers.launchMultiBoardDebug({
      boards: [{
        boardId: "board-a",
        probeSerial: "CL650001",
        ccxmlPath,
        cores: coreMap.map(core => ({ ...core, connect: false, load: false, haltAtEntry: false }))
      }]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "ProbeBindingInvalid",
        details: expect.objectContaining({ actualDebugProbeSelection: "1", expectedDebugProbeSelection: "0" })
      })
    }));
    expect(adapter.createSessionCount).toBe(0);
  });

  test("runIpcAcceptance fails closed before running either core when CPU2 program load fails", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-ipc-load-failure-"));
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu1MapPath = path.join(tempDir, "cpu1.map");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu1MapPath, "MEMORY CONFIGURATION\n  RAMLS0  00008000 00000800 00000010 000007f0 RWIX\n");
    await writeFile(cpu2MapPath, "MEMORY CONFIGURATION\n  RAMGS4  00018000 00002000 00000871 0000178f RWIX\n");
    const adapter = new Cpu2LoadFailureAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "ipc-load-failure", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    adapter.events.length = 0;

    const result = await handlers.runIpcAcceptance({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath,
      cpu2OutPath,
      cpu1MapPath,
      cpu2MapPath,
      resetType: "cpu",
      runSequence: { runCpu1First: true, runCpu2: true },
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "BatchOperationFailed",
        details: expect.objectContaining({
          failed: [expect.objectContaining({ coreId: 2, success: false })]
        })
      })
    }));
    expect(adapter.events).toEqual([
      "halt:0",
      "halt:2",
      "reset:0:cpu",
      "reset:2:cpu",
      "load:0:cpu1.out",
      "load:2:cpu2.out"
    ]);
    expect(adapter.events).not.toContain("run:0");
    expect(adapter.events).not.toContain("run:2");
  });

  test.each(["initialHalt", "reset", "postLoadHalt"] as const)("runIpcAcceptance fails closed when %s has a per-core failure", async stage => {
    const tempDir = await mkdtemp(path.join(tmpdir(), `c2000-mcp-ipc-${stage}-failure-`));
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu1MapPath = path.join(tempDir, "cpu1.map");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu1MapPath, "MEMORY CONFIGURATION\n  RAMLS0  00008000 00000800 00000010 000007f0 RWIX\n");
    await writeFile(cpu2MapPath, "MEMORY CONFIGURATION\n  RAMGS4  00018000 00002000 00000871 0000178f RWIX\n");
    const adapter = new CriticalBatchFailureAdapter(stage);
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: `ipc-${stage}-failure`, coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    adapter.events.length = 0;

    const result = await handlers.runIpcAcceptance({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath,
      cpu2OutPath,
      cpu1MapPath,
      cpu2MapPath,
      resetType: "cpu",
      runSequence: { runCpu1First: true, runCpu2: true },
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "BatchOperationFailed",
        details: expect.objectContaining({
          failed: [expect.objectContaining({ coreId: 2, success: false })]
        })
      })
    }));
    expect(adapter.events).not.toContain("run:0");
    expect(adapter.events).not.toContain("run:2");
  });

  test("runReloadAndDiagnose fails closed when reset has a per-core failure", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-reload-reset-failure-"));
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    const adapter = new CriticalBatchFailureAdapter("reset");
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "reload-reset-failure", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    adapter.events.length = 0;

    const result = await handlers.runReloadAndDiagnose({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath,
      cpu2OutPath,
      resetType: "cpu",
      runCpu1: true,
      runCpu2: false
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "BatchOperationFailed",
        details: expect.objectContaining({
          failed: [expect.objectContaining({ coreId: 2, success: false })]
        })
      })
    }));
    expect(adapter.events).not.toContain("load:0:cpu1.out");
    expect(adapter.events).not.toContain("load:2:cpu2.out");
  });

  test("runIpcAcceptance rejects output/map configuration mismatch before touching either core", async () => {
    const adapter = new WorkflowRecordingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "artifact-mismatch", coreMap });
    adapter.events.length = 0;

    const result = await handlers.runIpcAcceptance({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath: "C:/f28p65x/ipc_ex1_c28x1/CPU1_RAM/ipc_ex1_c28x1.out",
      cpu2OutPath: "C:/f28p65x/ipc_ex1_c28x2/CPU2_RAM/ipc_ex1_c28x2.out",
      cpu1MapPath: "C:/f28p65x/ipc_ex1_c28x1/CPU1_FLASH/ipc_ex1_c28x1.map",
      cpu2MapPath: "C:/f28p65x/ipc_ex1_c28x2/CPU2_RAM/ipc_ex1_c28x2.map",
      runSequence: { runCpu1First: true, runCpu2: true },
      timeoutMs: 20
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "ArtifactPairInvalid",
        details: expect.objectContaining({ issues: expect.arrayContaining([expect.stringContaining("configuration mismatch")]) })
      })
    }));
    expect(adapter.events).toEqual([]);
  });

  test("launchAndRunIpcAcceptance creates and connects both cores before one server-side IPC workflow", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-ipc-workflow-"));
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu1MapPath = path.join(tempDir, "cpu1.map");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu1MapPath, "MEMORY CONFIGURATION\n  RAMLS0                00008000   00000800  00000010  000007f0  RWIX\n");
    await writeFile(cpu2MapPath, [
      "MEMORY CONFIGURATION",
      "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX",
      "SECTION ALLOCATION MAP",
      ".text      0    00018000    000007bc"
    ].join("\n"));
    const adapter = new WorkflowRecordingAdapter({
      expressionValues: hybrid30kReadyExpressionValues
    });
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const input = {
      sessionName: "single-approval-ipc",
      ccxmlPath: "/tmp/f28p65x.ccxml",
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath,
      cpu2OutPath,
      cpu1MapPath,
      cpu2MapPath,
      resetType: "cpu" as const,
      runSequence: { runCpu1First: true, runCpu2: true },
      timeoutMs: 20,
      intervalMs: 1
    };
    const result = await handlers.launchAndRunIpcAcceptance(input);

    expect(adapter.events).toEqual([
      "connect:0",
      "connect:2",
      "halt:0",
      "halt:2",
      "reset:0:cpu",
      "reset:2:cpu",
      "load:0:cpu1.out",
      "load:2:cpu2.out",
      "halt:0",
      "halt:2",
      "run:0",
      "run:2"
    ]);
    expect(result).toEqual(expect.objectContaining({
      success: true,
      workflow: "c2000_launchAndRunIpcAcceptance",
      orchestration: "server-internal",
      mcpToolCalls: [],
      autoCloseOnComplete: false,
      sessionId: expect.any(String),
      launch: expect.objectContaining({
        sessionName: "single-approval-ipc",
        ccxmlPath: "/tmp/f28p65x.ccxml",
        connectedCoreIds: [0, 2]
      }),
      ipcReady: expect.objectContaining({ matched: true })
    }));
    await expect(manager.listCores(result.sessionId)).resolves.toHaveLength(2);

    const autoCloseResult = await handlers.launchAndRunIpcAcceptance({
      ...input,
      sessionName: "single-approval-ipc-auto-close",
      autoCloseOnComplete: true,
      autoCloseIdleTimeoutMs: 1000
    });
    expect(autoCloseResult).toEqual(expect.objectContaining({
      success: true,
      autoCloseOnComplete: true,
      autoClose: expect.objectContaining({ armed: true, idleTimeoutMs: 1000 }),
      sessionId: expect.any(String)
    }));
    await expect(manager.listCores(autoCloseResult.sessionId)).resolves.toHaveLength(2);
  });

  test("runBootHandoffDiagnosis returns explicit diagnosis evidence without client-side tool chaining", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-boot-workflow-"));
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu2MapPath, [
      "MEMORY CONFIGURATION",
      "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX",
      "SECTION ALLOCATION MAP",
      ".text      0    00018000    000007bc"
    ].join("\n"));
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        ...hybrid30kReadyExpressionValues,
        "g_stCoreCommCpu1Watch.ulIpcPass": { value: "0" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "boot-handoff-workflow", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.runBootHandoffDiagnosis({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu2MapPath
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      workflow: "c2000_runBootHandoffDiagnosis",
      orchestration: "server-internal",
      mcpToolCalls: [],
      diagnosisCode: "BOOT_HANDOFF_NOT_READY",
      severity: "warning",
      evidence: expect.objectContaining({
        explicitCores: { cpu1CoreId: 0, cpu2CoreId: 2 }
      }),
      recommendedActions: expect.arrayContaining([expect.stringContaining("IPC")]),
      cpu1: expect.objectContaining({ coreId: 0 }),
      cpu2: expect.objectContaining({ coreId: 2 }),
      ramOwnership: expect.objectContaining({
        ownershipActions: [expect.objectContaining({ targetCoreId: 2, memoryRegion: "RAMGS4" })]
      })
    }));
  });

  test("runReloadAndDiagnose reloads both cores then performs wait and boot diagnosis", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-reload-workflow-"));
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    const adapter = new WorkflowRecordingAdapter({
      expressionValues: hybrid30kReadyExpressionValues
    });
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);
    const created = await handlers.createDebugSession({ sessionName: "reload-diagnose-workflow", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    adapter.events.length = 0;

    const result = await handlers.runReloadAndDiagnose({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      cpu1OutPath,
      cpu2OutPath,
      resetType: "cpu",
      runCpu1: true,
      runCpu2: false,
      waitExpressions: [
        { coreId: 0, expression: "g_stCoreCommCpu1Watch.ulIpcPass", expected: 1 },
        { coreId: 2, expression: "g_stCoreCommCpu2Watch.emStage", expected: 5 }
      ],
      timeoutMs: 20,
      intervalMs: 1
    });

    expect(adapter.events).toEqual([
      "halt:0",
      "halt:2",
      "reset:0:cpu",
      "reset:2:cpu",
      "load:0:cpu1.out",
      "load:2:cpu2.out",
      "halt:0",
      "halt:2",
      "run:0"
    ]);
    expect(result).toEqual(expect.objectContaining({
      success: true,
      workflow: "c2000_runReloadAndDiagnose",
      wait: expect.objectContaining({ matched: true }),
      diagnosis: expect.objectContaining({ diagnosisCode: "BOOT_HANDOFF_READY" }),
      snapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0 }),
          expect.objectContaining({ coreId: 2 })
        ])
      })
    }));
  });

  test("runFullDebugBundle writes summary and structured evidence files", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-full-bundle-"));
    const outputDir = path.join(tempDir, "bundle");
    const cpu1OutPath = path.join(tempDir, "cpu1.out");
    const cpu2OutPath = path.join(tempDir, "cpu2.out");
    const cpu2MapPath = path.join(tempDir, "cpu2.map");
    await writeFile(cpu1OutPath, "cpu1-image");
    await writeFile(cpu2OutPath, "cpu2-image");
    await writeFile(cpu2MapPath, [
      "MEMORY CONFIGURATION",
      "  RAMGS4                00018000   00002000  00000871  0000178f  RWIX"
    ].join("\n"));
    const handlers = createHandlers(new OwnershipMismatchAdapter({
      expressionValues: hybrid30kReadyExpressionValues
    }));
    const created = await handlers.createDebugSession({ sessionName: "full-debug-bundle", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    await handlers.loadPrograms({
      sessionId: created.sessionId,
      programs: [
        { coreId: 0, programUri: cpu1OutPath },
        { coreId: 2, programUri: cpu2OutPath, mapUri: cpu2MapPath }
      ]
    });

    const result = await handlers.runFullDebugBundle({
      sessionId: created.sessionId,
      device: "F28P65x",
      cpu1CoreId: 0,
      cpu2CoreId: 2,
      coreIds: [0, 2],
      cpu1OutPath,
      cpu2OutPath,
      maps: [{ coreId: 2, coreName: "C28xx_CPU2", mapPath: cpu2MapPath }],
      expressions: [
        { coreId: 0, expressions: ["g_stCoreCommCpu1Watch.ulIpcPass"] },
        { coreId: 2, expressions: ["g_stCoreCommCpu2Watch.emStage"] }
      ],
      verifyRuntimeRamOwnership: true,
      outputDir
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      workflow: "c2000_runFullDebugBundle",
      bundle: expect.objectContaining({
        outputDir,
        files: expect.arrayContaining([
          path.join(outputDir, "summary.md"),
          path.join(outputDir, "snapshot.json"),
          path.join(outputDir, "boot-handoff.json")
        ])
      }),
      snapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0 }),
          expect.objectContaining({ coreId: 2 })
        ])
      }),
      expressions: expect.arrayContaining([
        expect.objectContaining({
          coreId: 0,
          results: [expect.objectContaining({ expression: "g_stCoreCommCpu1Watch.ulIpcPass" })]
        })
      ]),
      bootHandoff: expect.objectContaining({
        diagnosisCode: "BOOT_HANDOFF_NOT_READY",
        verdict: expect.objectContaining({ runtimeRamOwnershipReady: false, ready: false })
      }),
      runtimeRamOwnership: expect.objectContaining({ requested: true, matched: false })
    }));
  });

  test("getAcceptanceReadiness returns blockers without touching debug sessions", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-readiness-"));
    const ccxmlPath = path.join(tempDir, "f28p65x.ccxml");
    const cpu1Program = path.join(tempDir, "cpu1.out");
    const cpu2Program = path.join(tempDir, "cpu2.out");
    await writeFile(ccxmlPath, "<configurations />");
    await writeFile(cpu1Program, "cpu1");
    await writeFile(cpu2Program, "cpu2");
    const adapter = new CountingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      runHardwarePreflight: async (options = {}) => ({
        xdsdfuPath: `${options.ccsInstallPath}/ccs_base/common/uscif/xds110/xdsdfu`,
        xdsdfu: {
          ok: true,
          stdout: "xdsdfu output",
          stderr: "",
          devices: [
            { serialNumber: "CL650001", mode: "Runtime", configuration: "Standard", version: "3.0.0.43", name: "XDS110" }
          ]
        },
        debugProcesses: ["93717 ./DSLite"],
        debugProcessDetails: [{ pid: 93717, ppid: 93710, elapsed: "18:57:01", command: "./DSLite", kind: "DSLite", rawLine: "93717 ./DSLite" }]
      }),
      discoverAcceptancePrograms: async (options = {}) => ({
        searchRoots: options.searchRoots ?? [],
        cpu1: {
          selected: options.cpu1Program ?? cpu1Program,
          source: options.cpu1Program ? "env" : "discovered",
          candidates: [options.cpu1Program ?? cpu1Program]
        },
        cpu2: {
          selected: options.cpu2Program ?? cpu2Program,
          source: options.cpu2Program ? "env" : "discovered",
          candidates: [options.cpu2Program ?? cpu2Program]
        }
      })
    });

    const result = await handlers.getAcceptanceReadiness({
      ccsInstallPath: "/Applications/ti/ccs2100/ccs",
      ccxmlPath,
      searchRoots: [tempDir]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      readyForHardwareAcceptance: false,
      blockers: ["Existing debug-related process(es) may own the XDS probe: 93717 DSLite: ./DSLite"],
      checks: expect.objectContaining({
        ccxml: expect.objectContaining({ ok: true, path: ccxmlPath }),
        cpu1Program: expect.objectContaining({ ok: true, path: cpu1Program }),
        cpu2Program: expect.objectContaining({ ok: true, path: cpu2Program }),
        xds110: expect.objectContaining({ ok: true }),
        debugProcessOwnership: expect.objectContaining({
          ok: false,
          owners: "93717 DSLite: ./DSLite",
          details: [{ pid: 93717, ppid: 93710, elapsed: "18:57:01", command: "./DSLite", kind: "DSLite", rawLine: "93717 ./DSLite" }]
        })
      }),
      programDiscovery: expect.objectContaining({
        cpu1: expect.objectContaining({ selected: cpu1Program }),
        cpu2: expect.objectContaining({ selected: cpu2Program })
      }),
      preflight: expect.objectContaining({
        debugProcessDetails: [{ pid: 93717, ppid: 93710, elapsed: "18:57:01", command: "./DSLite", kind: "DSLite", rawLine: "93717 ./DSLite" }]
      }),
      debugBoundary: expect.objectContaining({
        officialTiMcpDebugControlsUsed: false,
        activeTargetAllowed: false,
        uiFocusRequired: false
      }),
      uiIndependenceEvidence: {
        success: true,
        evidence: "c2000_debug_boundary_ui_independence",
        debugControlPath: "c2000-multicore-mcp -> CCS Scripting DebugServer -> DebugSession(coreId)",
        officialTiMcpDebugControlsUsed: false,
        activeTargetAllowed: false,
        uiFocusRequired: false,
        selectedCpuRequired: false,
        requiredPerCoreInputs: ["sessionId", "coreId"],
        coreIdConvention: {
          "0": "C28xx_CPU1",
          "2": "C28xx_CPU2"
        },
        fallbackPolicy: "Debug control must not fall back to TI official MCP active-target tools."
      },
      acceptanceEvidence: expect.objectContaining({
        success: true,
        evidence: "c2000_multicore_acceptance_evidence_plan",
        hostReadinessTool: "c2000_getAcceptanceReadiness",
        hardwareAcceptanceTool: "c2000_verifyRunPauseIsolation",
        requirements: expect.arrayContaining([
          expect.objectContaining({ id: "continue_cpu1_only", proofLabel: "c2000_continue(cpu1)" }),
          expect.objectContaining({ id: "continue_cpu2_only", proofLabel: "c2000_continue(cpu2)" }),
          expect.objectContaining({ id: "pause_cpu1_only", proofLabel: "c2000_pause(cpu1)" }),
          expect.objectContaining({ id: "pause_cpu2_only", proofLabel: "c2000_pause(cpu2)" }),
          expect.objectContaining({ id: "multicore_snapshot", proofTool: "c2000_getMulticoreSnapshot" }),
          expect.objectContaining({ id: "no_ccs_ui_focus", evidenceField: "uiIndependenceEvidence" })
        ])
      }),
      nextCommand: expect.stringContaining("npm run acceptance:ccs:mcp")
    }));
    expect(result.nextCommand).toContain(`C2000_CPU1_OUT='${cpu1Program}'`);
    expect(result.nextCommand).toContain(`C2000_CPU2_OUT='${cpu2Program}'`);
    expect(adapter.createSessionCount).toBe(0);
  });

  test("getAcceptanceReadiness reports ready when host files, XDS110, and ownership checks pass", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-readiness-ready-"));
    const ccxmlPath = path.join(tempDir, "f28p65x.ccxml");
    const cpu1Program = path.join(tempDir, "cpu1.out");
    const cpu2Program = path.join(tempDir, "cpu2.out");
    await writeFile(ccxmlPath, "<configurations />");
    await writeFile(cpu1Program, "cpu1");
    await writeFile(cpu2Program, "cpu2");
    const handlers = createToolHandlers(new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry()), {
      runHardwarePreflight: async () => ({
        xdsdfuPath: "/Applications/ti/ccs2100/ccs/ccs_base/common/uscif/xds110/xdsdfu",
        xdsdfu: {
          ok: true,
          devices: [{ serialNumber: "CL650001", mode: "Runtime", configuration: "Standard", version: "3.0.0.43", name: "XDS110" }]
        },
        debugProcesses: [],
        debugProcessDetails: []
      }),
      discoverAcceptancePrograms: async () => ({
        searchRoots: [tempDir],
        cpu1: { selected: cpu1Program, source: "discovered", candidates: [cpu1Program] },
        cpu2: { selected: cpu2Program, source: "discovered", candidates: [cpu2Program] }
      })
    });

    const result = await handlers.getAcceptanceReadiness({ ccxmlPath, searchRoots: [tempDir] });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      readyForHardwareAcceptance: true,
      blockers: [],
      checks: expect.objectContaining({
        ccxml: expect.objectContaining({ ok: true }),
        cpu1Program: expect.objectContaining({ ok: true }),
        cpu2Program: expect.objectContaining({ ok: true }),
        xds110: expect.objectContaining({ ok: true }),
        debugProcessOwnership: expect.objectContaining({ ok: true })
      })
    }));
  });

  test("getAcceptanceReadiness waits for an existing probe owner to release", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-readiness-wait-"));
    const ccxmlPath = path.join(tempDir, "f28p65x.ccxml");
    const cpu1Program = path.join(tempDir, "cpu1.out");
    const cpu2Program = path.join(tempDir, "cpu2.out");
    await writeFile(ccxmlPath, "<configurations />");
    await writeFile(cpu1Program, "cpu1");
    await writeFile(cpu2Program, "cpu2");
    let preflightCalls = 0;
    const handlers = createToolHandlers(new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry()), {
      runHardwarePreflight: async () => {
        preflightCalls++;
        const owned = preflightCalls === 1;
        return {
          xdsdfuPath: "/Applications/ti/ccs2100/ccs/ccs_base/common/uscif/xds110/xdsdfu",
          xdsdfu: {
            ok: true,
            devices: [{ serialNumber: "CL650001", mode: "Runtime", configuration: "Standard", version: "3.0.0.43", name: "XDS110" }]
          },
          debugProcesses: owned ? ["93717 ./DSLite"] : [],
          debugProcessDetails: owned
            ? [{ pid: 93717, ppid: 93710, elapsed: "00:00:01", command: "./DSLite", kind: "DSLite", rawLine: "93717 ./DSLite" }]
            : []
        };
      },
      discoverAcceptancePrograms: async () => ({
        searchRoots: [tempDir],
        cpu1: { selected: cpu1Program, source: "discovered", candidates: [cpu1Program] },
        cpu2: { selected: cpu2Program, source: "discovered", candidates: [cpu2Program] }
      })
    });

    const result = await handlers.getAcceptanceReadiness({
      ccxmlPath,
      searchRoots: [tempDir],
      waitForProbeMs: 50,
      probePollIntervalMs: 1
    });

    expect(preflightCalls).toBe(2);
    expect(result).toEqual(expect.objectContaining({
      readyForHardwareAcceptance: true,
      probeWait: expect.objectContaining({ requestedMs: 50, attempts: 2, released: true })
    }));
  });

  test("getAcceptanceReadiness allows explicit debug-process override with a warning", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-readiness-override-"));
    const ccxmlPath = path.join(tempDir, "f28p65x.ccxml");
    const cpu1Program = path.join(tempDir, "cpu1.out");
    const cpu2Program = path.join(tempDir, "cpu2.out");
    await writeFile(ccxmlPath, "<configurations />");
    await writeFile(cpu1Program, "cpu1");
    await writeFile(cpu2Program, "cpu2");
    const handlers = createToolHandlers(new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry()), {
      runHardwarePreflight: async () => ({
        xdsdfuPath: "/Applications/ti/ccs2100/ccs/ccs_base/common/uscif/xds110/xdsdfu",
        xdsdfu: {
          ok: true,
          devices: [{ serialNumber: "CL650001", mode: "Runtime", configuration: "Standard", version: "3.0.0.43", name: "XDS110" }]
        },
        debugProcesses: ["93717 93710 18:59:56 ./DSLite"],
        debugProcessDetails: [{ pid: 93717, ppid: 93710, elapsed: "18:59:56", command: "./DSLite", kind: "DSLite", rawLine: "93717 93710 18:59:56 ./DSLite" }]
      }),
      discoverAcceptancePrograms: async () => ({
        searchRoots: [tempDir],
        cpu1: { selected: cpu1Program, source: "discovered", candidates: [cpu1Program] },
        cpu2: { selected: cpu2Program, source: "discovered", candidates: [cpu2Program] }
      })
    });

    const result = await handlers.getAcceptanceReadiness({
      ccxmlPath,
      searchRoots: [tempDir],
      allowExistingDebugProcesses: true
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      readyForHardwareAcceptance: true,
      blockers: [],
      warnings: ["Existing debug-related process override accepted: 93717 DSLite: ./DSLite"],
      checks: expect.objectContaining({
        debugProcessOwnership: expect.objectContaining({
          ok: true,
          overrideAccepted: true,
          owners: "93717 DSLite: ./DSLite",
          details: [{ pid: 93717, ppid: 93710, elapsed: "18:59:56", command: "./DSLite", kind: "DSLite", rawLine: "93717 93710 18:59:56 ./DSLite" }]
        })
      }),
      nextCommand: expect.stringContaining("C2000_ALLOW_EXISTING_DEBUG_PROCESSES='1'")
    }));
  });

  test("returns structured JSON for create/connect/run/getTargetState", async () => {
    const handlers = createHandlers();

    const created = await handlers.createDebugSession({ sessionName: "flow", coreMap });
    expect(created).toEqual(expect.objectContaining({ success: true, sessionId: expect.any(String), timestamp: expect.any(String) }));

    await expect(handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 })).resolves.toEqual(
      expect.objectContaining({ success: true, sessionId: created.sessionId, coreId: 0, coreName: "C28xx_CPU1" })
    );
    await handlers.runCore({ sessionId: created.sessionId, coreId: 0 });

    await expect(handlers.getTargetState({ sessionId: created.sessionId, coreId: 0 })).resolves.toEqual(
      expect.objectContaining({ success: true, sessionId: created.sessionId, coreId: 0, state: "Running" })
    );
  });

  test("getSessionTopology exposes the logical core mapping without target control", async () => {
    const handlers = createHandlers();
    const created = await handlers.createDebugSession({
      sessionName: "topology-tool",
      ccxmlPath: "/tmp/f28p65x.ccxml",
      coreMap
    });

    const result = await handlers.getSessionTopology({ sessionId: created.sessionId });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      sessionName: "topology-tool",
      ccxmlPath: "/tmp/f28p65x.ccxml",
      adapterName: "mock",
      adapterSessionId: expect.stringMatching(/^mock-/),
      debugSessionRoute: "sessionId -> adapterSessionId -> coreId -> DebugSession",
      cores: [
        expect.objectContaining({ coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", targetSelector: "C28xx_CPU1", debugSessionKey: expect.stringMatching(/^mock-.*:0$/) }),
        expect.objectContaining({ coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", targetSelector: "C28xx_CPU2", debugSessionKey: expect.stringMatching(/^mock-.*:2$/) })
      ]
    }));
  });

  test("createDebugSession returns a structured DuplicateCoreId error for ambiguous core maps", async () => {
    const handlers = createHandlers();

    const result = await handlers.createDebugSession({
      sessionName: "duplicate-core-id",
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
        { coreId: 0, coreName: "C28xx_CPU1_ALIAS", corePattern: "C28xx_CPU1" }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "DuplicateCoreId",
        details: expect.objectContaining({ coreId: 0 })
      })
    }));
  });

  test("createDebugSession returns a structured DuplicateCoreTarget error for ambiguous target mappings", async () => {
    const handlers = createHandlers();

    const result = await handlers.createDebugSession({
      sessionName: "duplicate-core-target",
      coreMap: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1" },
        { coreId: 2, coreName: "C28xx_CPU2_ALIAS", corePattern: "C28xx_CPU1" }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: "DuplicateCoreTarget",
        details: expect.objectContaining({ coreTarget: "C28xx_CPU1" })
      })
    }));
  });

  test("evaluateMany reports each expression independently", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_emHybrid30kCpu1Stage: { value: "3", type: "uint16_t", address: "0x00001234" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "eval", coreMap });
    await handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 });

    const result = await handlers.evaluateMany({
      sessionId: created.sessionId,
      coreId: 0,
      expressions: ["g_emHybrid30kCpu1Stage", "g_ulHybrid30kIpcPass"]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      coreName: "C28xx_CPU1",
      results: [
        expect.objectContaining({ expression: "g_emHybrid30kCpu1Stage", success: true, value: "3" }),
        expect.objectContaining({ expression: "g_ulHybrid30kIpcPass", success: false, error: expect.objectContaining({ code: "SymbolNotFound" }) })
      ]
    }));
  });

  test("loadProgram and getLoadedProgramInfo expose hash metadata through handlers", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-handler-"));
    const programUri = path.join(tempDir, "cpu1.out");
    await writeFile(programUri, "image");
    const handlers = createHandlers();
    const created = await handlers.createDebugSession({ sessionName: "load", coreMap });
    await handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 });

    await expect(handlers.loadProgram({ sessionId: created.sessionId, coreId: 0, programUri })).resolves.toEqual(
      expect.objectContaining({ success: true, programUri, sha256: expect.any(String) })
    );
    await expect(handlers.getLoadedProgramInfo({ sessionId: created.sessionId, coreId: 0 })).resolves.toEqual(
      expect.objectContaining({ success: true, coreName: "C28xx_CPU1", programUri, warning: expect.stringContaining("loaded through this MCP") })
    );
    await expect(handlers.getLoadedProgramInfo({ sessionId: created.sessionId, coreId: 2 })).resolves.toEqual(
      expect.objectContaining({ success: true, coreName: "C28xx_CPU2", warning: expect.stringContaining("No program was loaded") })
    );
  });

  test("batch handlers return top-level failure when any requested core fails", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-batch-"));
    const programUri = path.join(tempDir, "cpu.out");
    await writeFile(programUri, "image");
    const handlers = createHandlers();
    const created = await handlers.createDebugSession({ sessionName: "partial-batch", coreMap });
    await handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 });

    await expect(handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 9] })).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "BatchOperationFailed" }),
        results: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, success: true }),
          expect.objectContaining({ coreId: 9, success: false, error: expect.objectContaining({ code: "CoreNotFound" }) })
        ])
      })
    );

    await expect(handlers.loadPrograms({
      sessionId: created.sessionId,
      programs: [
        { coreId: 0, programUri },
        { coreId: 9, programUri }
      ]
    })).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "BatchOperationFailed" }),
        results: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, success: true, programUri }),
          expect.objectContaining({ coreId: 9, success: false, error: expect.objectContaining({ code: "CoreNotFound" }) })
        ])
      })
    );
  });

  test("waitUntilExpression returns the last value on timeout", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "0", type: "uint32_t", address: "0x00002000" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "wait", coreMap });
    await handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 });

    const result = await handlers.waitUntilExpression({
      sessionId: created.sessionId,
      coreId: 0,
      expression: "g_ulHybrid30kIpcPass",
      expected: 1,
      timeoutMs: 20,
      intervalMs: 5
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      coreName: "C28xx_CPU1",
      timedOut: true,
      lastResult: expect.objectContaining({ value: "0" })
    }));
  });

  test("core read helpers include coreName response identity", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "core-read-identity", coreMap });
    await handlers.connectTarget({ sessionId: created.sessionId, coreId: 0 });

    await expect(handlers.resolvePc({ sessionId: created.sessionId, coreId: 0 })).resolves.toEqual(
      expect.objectContaining({ success: true, coreId: 0, coreName: "C28xx_CPU1", partial: true })
    );
    // resolveAddress is honest about missing symbol/source mapping (partial, success=false).
    await expect(handlers.resolveAddress({ sessionId: created.sessionId, coreId: 0, address: "0x00C4E1" })).resolves.toEqual(
      expect.objectContaining({
        success: false,
        coreId: 0,
        coreName: "C28xx_CPU1",
        address: "0x00C4E1",
        partial: true,
        error: expect.objectContaining({ code: "AddressResolveFailed" })
      })
    );
    await expect(handlers.waitUntilExpression({
      sessionId: created.sessionId,
      coreId: 0,
      expression: "g_ulHybrid30kIpcPass",
      expected: 1,
      timeoutMs: 20,
      intervalMs: 5
    })).resolves.toEqual(
      expect.objectContaining({ success: true, coreId: 0, coreName: "C28xx_CPU1", matched: true })
    );
  });

  test("closeDebugSession returns success and subsequent calls for that session fail", async () => {
    const handlers = createHandlers();
    const created = await handlers.createDebugSession({ sessionName: "close-tool", coreMap });

    await expect(handlers.closeDebugSession({ sessionId: created.sessionId })).resolves.toEqual(
      expect.objectContaining({ success: true, sessionId: created.sessionId })
    );
    await expect(handlers.listCores({ sessionId: created.sessionId })).resolves.toEqual(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: "SessionNotFound" }) })
    );
  });

  test("diagnoseCpu2Boot returns snapshot and per-core boot expressions", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        "g_stCoreCommCpu1Watch.emStage": { value: "2", type: "enum", address: "0x0000A844" },
        "g_stCoreCommCpu1Watch.ulIpcPass": { value: "0", type: "uint32_t", address: "0x0000A802" },
        "g_stCoreCommCpu1Watch.ulCpu2Ready": { value: "0", type: "uint32_t", address: "0x0000A80A" },
        "g_stCoreCommCpu1Watch.ulCpu2BootLastError": { value: "1", type: "uint32_t", address: "0x0000A816" },
        "g_stCoreCommCpu2Watch.emStage": { value: "0", type: "enum", address: "0x00018870" },
        "g_stCoreCommCpu2Watch.ulInitialParameterSnapshotSeq": { value: "0", type: "uint32_t" },
        "g_stCoreCommCpu2Watch.ulInitialParameterApplied": { value: "0", type: "uint32_t" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "diag-cpu2", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.diagnoseCpu2Boot({ sessionId: created.sessionId, cpu1CoreId: 0, cpu2CoreId: 2 });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      cpu1: expect.objectContaining({
        coreId: 0,
        expressions: expect.arrayContaining([
          expect.objectContaining({ expression: "g_stCoreCommCpu1Watch.emStage", success: true, value: "2" }),
          expect.objectContaining({ expression: "g_stCoreCommCpu1Watch.ulIpcPass", success: true, value: "0" })
        ])
      }),
      cpu2: expect.objectContaining({
        coreId: 2,
        expressions: expect.arrayContaining([
          expect.objectContaining({ expression: "g_stCoreCommCpu2Watch.emStage", success: true, value: "0" })
        ])
      }),
      snapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, name: "C28xx_CPU1" }),
          expect.objectContaining({ coreId: 2, name: "C28xx_CPU2" })
        ])
      })
    }));
  });

  test("verifyRunPauseIsolation returns per-step assertions for CPU1 and CPU2", async () => {
    const handlers = createHandlers();
    const created = await handlers.createDebugSession({ sessionName: "verify-isolation", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });
    await handlers.haltCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.verifyRunPauseIsolation({ sessionId: created.sessionId, settleMs: 1 });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      steps: [
        expect.objectContaining({
          label: "c2000_continue(cpu1)",
          assertion: expect.objectContaining({ targetCoreId: 0, expectedTargetState: "Running", success: true })
        }),
        expect.objectContaining({
          label: "c2000_pause(cpu1)",
          assertion: expect.objectContaining({ targetCoreId: 0, expectedTargetState: "Halted", success: true })
        }),
        expect.objectContaining({
          label: "c2000_continue(cpu2)",
          assertion: expect.objectContaining({ targetCoreId: 2, expectedTargetState: "Running", success: true })
        }),
        expect.objectContaining({
          label: "c2000_pause(cpu2)",
          assertion: expect.objectContaining({ targetCoreId: 2, expectedTargetState: "Halted", success: true })
        })
      ],
      finalSnapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, state: "Halted" }),
          expect.objectContaining({ coreId: 2, state: "Halted" })
        ])
      }),
      acceptanceSummary: expect.objectContaining({
        success: true,
        requiredLabels: [
          "c2000_continue(cpu1)",
          "c2000_pause(cpu1)",
          "c2000_continue(cpu2)",
          "c2000_pause(cpu2)"
        ],
        steps: [
          expect.objectContaining({ label: "c2000_continue(cpu1)", targetCoreId: 0, expectedTargetState: "Running", success: true }),
          expect.objectContaining({ label: "c2000_pause(cpu1)", targetCoreId: 0, expectedTargetState: "Halted", success: true }),
          expect.objectContaining({ label: "c2000_continue(cpu2)", targetCoreId: 2, expectedTargetState: "Running", success: true }),
          expect.objectContaining({ label: "c2000_pause(cpu2)", targetCoreId: 2, expectedTargetState: "Halted", success: true })
        ]
      })
    }));
  });

  test("assignExpression returns a verified per-core fault injection result", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "assign-expression", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.assignExpression({
      sessionId: created.sessionId,
      coreId: 0,
      expression: "g_ulHybrid30kIpcPass",
      value: 0
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      coreId: 0,
      expression: "g_ulHybrid30kIpcPass",
      assignedValue: "0",
      readback: expect.objectContaining({ success: true, value: "0" })
    }));
    await expect(handlers.evaluateMany({
      sessionId: created.sessionId,
      coreId: 2,
      expressions: ["g_ulHybrid30kIpcPass"]
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      results: [expect.objectContaining({ value: "1" })]
    }));
  });

  test("assignExpressions returns batch failure with explicit per-core results", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kCpu1Fault: { value: "0", type: "uint32_t", address: "0x00002030" },
        g_ulHybrid30kCpu2Fault: { value: "0", type: "uint32_t", address: "0x00012030" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "batch-assign-tool", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.assignExpressions({
      sessionId: created.sessionId,
      assignments: [
        { coreId: 0, expression: "g_ulHybrid30kCpu1Fault", value: 1 },
        { coreId: 2, expression: "g_ulHybrid30kCpu2Fault", value: true },
        { coreId: 9, expression: "g_ulHybrid30kMissingCoreFault", value: 1 }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: created.sessionId,
      error: expect.objectContaining({ code: "BatchOperationFailed" }),
      results: [
        expect.objectContaining({ coreId: 0, success: true, expression: "g_ulHybrid30kCpu1Fault", assignedValue: "1" }),
        expect.objectContaining({ coreId: 2, success: true, expression: "g_ulHybrid30kCpu2Fault", assignedValue: "1" }),
        expect.objectContaining({ coreId: 9, success: false, expression: "g_ulHybrid30kMissingCoreFault", error: expect.objectContaining({ code: "CoreNotFound" }) })
      ]
    }));
  });

  test("injectFaults returns labeled batch failure with explicit per-core results", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kCpu1Fault: { value: "0", type: "uint32_t", address: "0x00002030" },
        g_ulHybrid30kCpu2Fault: { value: "0", type: "uint32_t", address: "0x00012030" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "inject-faults-tool", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.injectFaults({
      sessionId: created.sessionId,
      faults: [
        { label: "cpu1-trip", coreId: 0, expression: "g_ulHybrid30kCpu1Fault", value: 1 },
        { label: "missing-core", coreId: 9, expression: "g_ulHybrid30kMissingCoreFault", value: 1 }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: created.sessionId,
      summary: { total: 2, succeeded: 1, failed: 1 },
      error: expect.objectContaining({ code: "BatchOperationFailed" }),
      results: [
        expect.objectContaining({ label: "cpu1-trip", coreId: 0, success: true, expression: "g_ulHybrid30kCpu1Fault", assignedValue: "1" }),
        expect.objectContaining({ label: "missing-core", coreId: 9, success: false, expression: "g_ulHybrid30kMissingCoreFault", error: expect.objectContaining({ code: "CoreNotFound" }) })
      ]
    }));
  });

  test("compareExpressions returns parameter synchronization matches and mismatches", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kCpu1ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00002010" },
        g_ulHybrid30kCpu2ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00012010" },
        g_ulHybrid30kCpu1FaultCount: { value: "0", type: "uint32_t", address: "0x00002020" },
        g_ulHybrid30kCpu2FaultCount: { value: "1", type: "uint32_t", address: "0x00012020" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "compare-expressions", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.compareExpressions({
      sessionId: created.sessionId,
      comparisons: [
        {
          label: "param-crc",
          left: { coreId: 0, expression: "g_ulHybrid30kCpu1ParamCrc" },
          right: { coreId: 2, expression: "g_ulHybrid30kCpu2ParamCrc" }
        },
        {
          label: "fault-count",
          left: { coreId: 0, expression: "g_ulHybrid30kCpu1FaultCount" },
          right: { coreId: 2, expression: "g_ulHybrid30kCpu2FaultCount" }
        }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      matched: false,
      comparisons: [
        expect.objectContaining({ label: "param-crc", matched: true }),
        expect.objectContaining({ label: "fault-count", matched: false })
      ]
    }));
  });

  test("waitForExpressionSet returns matched when all explicit-core conditions are satisfied", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" },
        g_emHybrid30kCpu2Stage: { value: "3", type: "uint16_t", address: "0x00018870" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "wait-expression-set", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.waitForExpressionSet({
      sessionId: created.sessionId,
      conditions: [
        { label: "cpu1-ipc-pass", coreId: 0, expression: "g_ulHybrid30kIpcPass", expected: 1 },
        { label: "cpu2-stage", coreId: 2, expression: "g_emHybrid30kCpu2Stage", expected: "3" }
      ],
      timeoutMs: 20,
      intervalMs: 5
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      sessionId: created.sessionId,
      matched: true,
      timedOut: false,
      conditions: [
        expect.objectContaining({ label: "cpu1-ipc-pass", coreId: 0, matched: true, result: expect.objectContaining({ value: "1" }) }),
        expect.objectContaining({ label: "cpu2-stage", coreId: 2, matched: true, result: expect.objectContaining({ value: "3" }) })
      ]
    }));
  });

  test("waitForExpressionSet returns last results when any explicit-core condition times out", async () => {
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "0", type: "uint32_t", address: "0x00002000" },
        g_emHybrid30kCpu2Stage: { value: "3", type: "uint16_t", address: "0x00018870" }
      }
    }));
    const created = await handlers.createDebugSession({ sessionName: "wait-expression-set-timeout", coreMap });
    await handlers.connectCores({ sessionId: created.sessionId, coreIds: [0, 2] });

    const result = await handlers.waitForExpressionSet({
      sessionId: created.sessionId,
      conditions: [
        { label: "cpu1-ipc-pass", coreId: 0, expression: "g_ulHybrid30kIpcPass", expected: 1 },
        { label: "cpu2-stage", coreId: 2, expression: "g_emHybrid30kCpu2Stage", expected: "3" }
      ],
      timeoutMs: 20,
      intervalMs: 5
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      matched: false,
      timedOut: true,
      conditions: [
        expect.objectContaining({ label: "cpu1-ipc-pass", coreId: 0, matched: false, result: expect.objectContaining({ value: "0" }) }),
        expect.objectContaining({ label: "cpu2-stage", coreId: 2, matched: true, result: expect.objectContaining({ value: "3" }) })
      ]
    }));
  });

  test("launchMulticoreDebug can run post-launch wait, diagnosis and isolation checks", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        ...hybrid30kReadyExpressionValues,
        g_ulHybrid30kIpcPass: { value: "1", type: "uint32_t", address: "0x00002000" },
        g_emHybrid30kCpu2Stage: { value: "0", type: "uint16_t", address: "0x00018870" }
      }
    }));

    const result = await handlers.launchMulticoreDebug({
      sessionName: "advanced-launch",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchChecks: {
        waitForExpressionSet: {
          conditions: [
            { label: "cpu1-ipc-pass", coreId: 0, expression: "g_ulHybrid30kIpcPass", expected: 1 },
            { label: "cpu2-stage", coreId: 2, expression: "g_emHybrid30kCpu2Stage", expected: "0" }
          ],
          timeoutMs: 20,
          intervalMs: 5
        },
        diagnoseCpu2Boot: { cpu1CoreId: 0, cpu2CoreId: 2 },
        verifyRunPauseIsolation: { cpu1CoreId: 0, cpu2CoreId: 2, settleMs: 1 }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      autoCloseOnComplete: false,
      sessionId: expect.any(String),
      snapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, state: "Halted", loadedProgram: cpu1Out }),
          expect.objectContaining({ coreId: 2, state: "Halted", loadedProgram: cpu2Out })
        ])
      }),
      postLaunchChecks: expect.objectContaining({
        waitForExpressionSet: expect.objectContaining({ matched: true, timedOut: false }),
        diagnoseCpu2Boot: expect.objectContaining({ cpu1: expect.objectContaining({ coreId: 0 }), cpu2: expect.objectContaining({ coreId: 2 }) }),
        verifyRunPauseIsolation: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ label: "c2000_continue(cpu1)" }),
            expect.objectContaining({ label: "c2000_pause(cpu2)" })
          ])
        })
      })
    }));
  });

  test("launchMulticoreDebug arms activity-aware idle cleanup after successful checks when requested", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "auto-close-successful-launch",
      autoCloseOnComplete: true,
      autoCloseIdleTimeoutMs: 1000,
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", connect: true, load: false, haltAtEntry: true }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      autoCloseOnComplete: true,
      autoClose: expect.objectContaining({ armed: true, idleTimeoutMs: 1000 }),
      sessionId: expect.any(String),
      snapshot: expect.objectContaining({ cores: [expect.objectContaining({ coreId: 0 })] })
    }));
    await expect(manager.listCores(result.sessionId)).resolves.toHaveLength(1);
  });

  test("launchMulticoreDebug can discover missing CPU1 and CPU2 programs before loading", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-discovery-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      discoverAcceptancePrograms: async (options = {}) => ({
        searchRoots: options.searchRoots ?? [],
        cpu1: { selected: cpu1Out, source: "discovered", candidates: [cpu1Out] },
        cpu2: { selected: cpu2Out, source: "discovered", candidates: [cpu2Out] }
      })
    });

    const result = await handlers.launchMulticoreDebug({
      sessionName: "launch-discovered-programs",
      programDiscovery: { enabled: true, searchRoots: [tempDir] },
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", load: true, connect: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", load: true, connect: true, haltAtEntry: true }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      programDiscovery: expect.objectContaining({
        searchRoots: [tempDir],
        cpu1: expect.objectContaining({ selected: cpu1Out, source: "discovered" }),
        cpu2: expect.objectContaining({ selected: cpu2Out, source: "discovered" })
      }),
      snapshot: expect.objectContaining({
        cores: expect.arrayContaining([
          expect.objectContaining({ coreId: 0, loadedProgram: cpu1Out }),
          expect.objectContaining({ coreId: 2, loadedProgram: cpu2Out })
        ])
      })
    }));
  });

  test("launchMulticoreDebug rejects incomplete discovery before creating a target session", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-discovery-missing-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const adapter = new CountingAdapter();
    const manager = new DebugSessionManager(adapter, new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager, {
      discoverAcceptancePrograms: async (options = {}) => ({
        searchRoots: options.searchRoots ?? [],
        cpu1: { selected: cpu1Out, source: "discovered", candidates: [cpu1Out] },
        cpu2: { source: "missing", candidates: [] }
      })
    });

    const result = await handlers.launchMulticoreDebug({
      sessionName: "launch-discovery-missing-program",
      programDiscovery: { enabled: true, searchRoots: [tempDir] },
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", load: true, connect: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", load: true, connect: true, haltAtEntry: true }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      programDiscovery: expect.objectContaining({
        cpu1: expect.objectContaining({ selected: cpu1Out }),
        cpu2: expect.objectContaining({ source: "missing", candidates: [] })
      }),
      error: expect.objectContaining({
        code: "LaunchProgramMissing",
        details: expect.objectContaining({ coreId: 2 })
      })
    }));
    expect(result.sessionId).toBeUndefined();
    expect(result.cleanedUp).toBeUndefined();
    expect(adapter.createSessionCount).toBe(0);
  });

  test("launchMulticoreDebug rejects incompatible RAM/FLASH pairs before creating a target session", async () => {
    const adapter = new CountingAdapter();
    const handlers = createHandlers(adapter);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "mismatched-build-configs",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", programUri: "C:/f28p65x/ipc_ex1_c28x1/CPU1_RAM/ipc_ex1_c28x1.out" },
        { coreId: 2, coreName: "C28xx_CPU2", programUri: "C:/f28p65x/ipc_ex1_c28x2/CPU2_FLASH/ipc_ex1_c28x2.out" }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: "ArtifactPairInvalid" }),
      artifactPair: expect.objectContaining({ compatible: false })
    }));
    expect(adapter.createSessionCount).toBe(0);
  });

  test("launchMulticoreDebug passes explicit isolation core ids from postLaunchChecks", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-explicit-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const handlers = createHandlers(new MockDebugAdapter());

    const result = await handlers.launchMulticoreDebug({
      sessionName: "explicit-isolation-cores",
      cores: [
        { coreId: 4, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 6, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchChecks: {
        verifyRunPauseIsolation: { cpu1CoreId: 4, cpu2CoreId: 6, settleMs: 1 }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      postLaunchChecks: expect.objectContaining({
        verifyRunPauseIsolation: expect.objectContaining({
          acceptanceSummary: expect.objectContaining({
            steps: [
              expect.objectContaining({ label: "c2000_continue(cpu1)", targetCoreId: 4, peerCoreIds: [6], success: true }),
              expect.objectContaining({ label: "c2000_pause(cpu1)", targetCoreId: 4, peerCoreIds: [6], success: true }),
              expect.objectContaining({ label: "c2000_continue(cpu2)", targetCoreId: 6, peerCoreIds: [4], success: true }),
              expect.objectContaining({ label: "c2000_pause(cpu2)", targetCoreId: 6, peerCoreIds: [4], success: true })
            ]
          })
        })
      })
    }));
  });

  test("launchMulticoreDebug can run post-launch per-core assignments before compare checks", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-actions-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kBatchFault: { value: "0", type: "uint32_t", address: "0x00002030" },
        g_ulHybrid30kCpu1ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00002010" },
        g_ulHybrid30kCpu2ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00012010" }
      }
    }));

    const result = await handlers.launchMulticoreDebug({
      sessionName: "launch-actions-and-compare",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchActions: {
        assignExpressions: [
          { coreId: 0, expression: "g_ulHybrid30kBatchFault", value: 1 },
          { coreId: 2, expression: "g_ulHybrid30kBatchFault", value: 1 }
        ]
      },
      postLaunchChecks: {
        compareExpressions: [
          {
            label: "param-crc",
            left: { coreId: 0, expression: "g_ulHybrid30kCpu1ParamCrc" },
            right: { coreId: 2, expression: "g_ulHybrid30kCpu2ParamCrc" }
          },
          {
            label: "batch-fault-sync",
            left: { coreId: 0, expression: "g_ulHybrid30kBatchFault" },
            right: { coreId: 2, expression: "g_ulHybrid30kBatchFault" }
          }
        ]
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      postLaunchActions: expect.objectContaining({
        assignExpressions: expect.objectContaining({
          results: [
            expect.objectContaining({ coreId: 0, success: true, assignedValue: "1" }),
            expect.objectContaining({ coreId: 2, success: true, assignedValue: "1" })
          ]
        })
      }),
      postLaunchChecks: expect.objectContaining({
        compareExpressions: expect.objectContaining({
          matched: true,
          comparisons: [
            expect.objectContaining({ label: "param-crc", matched: true }),
            expect.objectContaining({ label: "batch-fault-sync", matched: true })
          ]
        })
      })
    }));
  });

  test("launchMulticoreDebug can run labeled fault injections before compare checks", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-faults-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const handlers = createHandlers(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kInjectedFault: { value: "0", type: "uint32_t", address: "0x00002030" }
      }
    }));

    const result = await handlers.launchMulticoreDebug({
      sessionName: "launch-fault-actions-and-compare",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchActions: {
        injectFaults: [
          { label: "cpu1-fault", coreId: 0, expression: "g_ulHybrid30kInjectedFault", value: 5 },
          { label: "cpu2-fault", coreId: 2, expression: "g_ulHybrid30kInjectedFault", value: 5 }
        ]
      },
      postLaunchChecks: {
        compareExpressions: [
          {
            label: "fault-sync",
            left: { coreId: 0, expression: "g_ulHybrid30kInjectedFault" },
            right: { coreId: 2, expression: "g_ulHybrid30kInjectedFault" }
          }
        ]
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      postLaunchActions: expect.objectContaining({
        injectFaults: expect.objectContaining({
          summary: { total: 2, succeeded: 2, failed: 0 },
          results: [
            expect.objectContaining({ label: "cpu1-fault", coreId: 0, success: true, assignedValue: "5" }),
            expect.objectContaining({ label: "cpu2-fault", coreId: 2, success: true, assignedValue: "5" })
          ]
        })
      }),
      postLaunchChecks: expect.objectContaining({
        compareExpressions: expect.objectContaining({
          matched: true,
          comparisons: [expect.objectContaining({ label: "fault-sync", matched: true })]
        })
      })
    }));
  });

  test("launchMulticoreDebug fails and cleans up when post-launch fault injection fails", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-fault-fail-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kInjectedFault: { value: "0", type: "uint32_t", address: "0x00002030" }
      }
    }), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "post-fault-fail-cleanup",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchActions: {
        injectFaults: [
          { label: "missing-core-fault", coreId: 9, expression: "g_ulHybrid30kInjectedFault", value: 1 }
        ]
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: expect.any(String),
      cleanedUp: true,
      postLaunchActions: expect.objectContaining({
        injectFaults: expect.objectContaining({
          summary: { total: 1, succeeded: 0, failed: 1 },
          results: [expect.objectContaining({ label: "missing-core-fault", coreId: 9, success: false })]
        })
      }),
      error: expect.objectContaining({ code: "PostLaunchActionFailed" })
    }));
    await expect(manager.listCores(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("launchMulticoreDebug fails and cleans up when a required compare check does not match", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-compare-fail-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kCpu1ParamCrc: { value: "0x55AA", type: "uint32_t", address: "0x00002010" },
        g_ulHybrid30kCpu2ParamCrc: { value: "0x1234", type: "uint32_t", address: "0x00012010" }
      }
    }), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "post-compare-fail-cleanup",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchChecks: {
        compareExpressions: [
          {
            label: "param-crc",
            left: { coreId: 0, expression: "g_ulHybrid30kCpu1ParamCrc" },
            right: { coreId: 2, expression: "g_ulHybrid30kCpu2ParamCrc" }
          }
        ]
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: expect.any(String),
      cleanedUp: true,
      postLaunchChecks: expect.objectContaining({
        compareExpressions: expect.objectContaining({
          matched: false,
          comparisons: [expect.objectContaining({ label: "param-crc", matched: false })]
        })
      }),
      error: expect.objectContaining({ code: "PostLaunchCheckFailed" })
    }));
    await expect(manager.listCores(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("launchMulticoreDebug fails and cleans up when a post-launch expression check does not match", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-check-fail-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    await writeFile(cpu1Out, "cpu1-image");
    const manager = new DebugSessionManager(new MockDebugAdapter({
      expressionValues: {
        g_ulHybrid30kIpcPass: { value: "0", type: "uint32_t", address: "0x00002000" }
      }
    }), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "post-check-fail-cleanup",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchChecks: {
        waitForExpressionSet: {
          conditions: [
            { label: "cpu1-ipc-pass", coreId: 0, expression: "g_ulHybrid30kIpcPass", expected: 1 }
          ],
          timeoutMs: 10,
          intervalMs: 5
        }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: expect.any(String),
      cleanedUp: true,
      postLaunchChecks: expect.objectContaining({
        waitForExpressionSet: expect.objectContaining({
          matched: false,
          timedOut: true,
          conditions: [
            expect.objectContaining({ label: "cpu1-ipc-pass", matched: false, result: expect.objectContaining({ value: "0" }) })
          ]
        })
      }),
      error: expect.objectContaining({ code: "PostLaunchCheckFailed" })
    }));
    await expect(manager.listCores(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("launchMulticoreDebug fails and cleans up when isolation acceptance summary is missing", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-isolation-malformed-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    (manager as any).verifyRunPauseIsolation = async (options: { sessionId: string }) => ({
      sessionId: options.sessionId,
      initialSnapshot: await manager.getMulticoreSnapshot(options.sessionId),
      steps: [],
      finalSnapshot: await manager.getMulticoreSnapshot(options.sessionId)
    });
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "post-isolation-malformed-cleanup",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchChecks: {
        verifyRunPauseIsolation: { settleMs: 1 }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: expect.any(String),
      cleanedUp: true,
      postLaunchChecks: expect.objectContaining({
        verifyRunPauseIsolation: expect.not.objectContaining({
          acceptanceSummary: expect.anything()
        })
      }),
      error: expect.objectContaining({ code: "PostLaunchCheckFailed" })
    }));
    await expect(manager.listCores(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("launchMulticoreDebug fails and cleans up when isolation acceptance summary has the wrong evidence", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "c2000-mcp-launch-isolation-wrong-evidence-"));
    const cpu1Out = path.join(tempDir, "cpu1.out");
    const cpu2Out = path.join(tempDir, "cpu2.out");
    await writeFile(cpu1Out, "cpu1-image");
    await writeFile(cpu2Out, "cpu2-image");
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    (manager as any).verifyRunPauseIsolation = async (options: { sessionId: string }) => ({
      sessionId: options.sessionId,
      initialSnapshot: await manager.getMulticoreSnapshot(options.sessionId),
      steps: [],
      acceptanceSummary: {
        success: true,
        evidence: "mocked-shortcut",
        requiredLabels: [],
        steps: []
      },
      finalSnapshot: await manager.getMulticoreSnapshot(options.sessionId)
    });
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "post-isolation-wrong-evidence-cleanup",
      cores: [
        { coreId: 0, coreName: "C28xx_CPU1", corePattern: "C28xx_CPU1", programUri: cpu1Out, connect: true, load: true, haltAtEntry: true },
        { coreId: 2, coreName: "C28xx_CPU2", corePattern: "C28xx_CPU2", programUri: cpu2Out, connect: true, load: true, haltAtEntry: true }
      ],
      postLaunchChecks: {
        verifyRunPauseIsolation: { settleMs: 1 }
      }
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: expect.any(String),
      cleanedUp: true,
      postLaunchChecks: expect.objectContaining({
        verifyRunPauseIsolation: expect.objectContaining({
          acceptanceSummary: expect.objectContaining({
            success: true,
            evidence: "mocked-shortcut"
          })
        })
      }),
      error: expect.objectContaining({ code: "PostLaunchCheckFailed" })
    }));
    await expect(manager.listCores(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  test("launchMulticoreDebug cleans up the logical session when launch fails after creation", async () => {
    const manager = new DebugSessionManager(new MockDebugAdapter(), new LoadedProgramRegistry());
    const handlers = createToolHandlers(manager);

    const result = await handlers.launchMulticoreDebug({
      sessionName: "launch-fail-cleanup",
      cores: [
        {
          coreId: 0,
          coreName: "C28xx_CPU1",
          corePattern: "C28xx_CPU1",
          programUri: path.join(tmpdir(), "does-not-exist.out"),
          connect: true,
          load: true,
          haltAtEntry: true
        }
      ]
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      sessionId: expect.any(String),
      cleanedUp: true,
      error: expect.objectContaining({ code: "ProgramFileNotFound" })
    }));
    await expect(manager.listCores(result.sessionId)).rejects.toMatchObject({ code: "SessionNotFound" });
  });
});

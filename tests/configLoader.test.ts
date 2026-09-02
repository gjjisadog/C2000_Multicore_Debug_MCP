import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { loadConfig } from "../src/config/config.loader.js";
import type { TiEnvironmentResolution } from "../src/config/tiPaths.js";

const originalEnv = { ...process.env };

describe("loadConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("loads DSS timeout from C2000_MCP_DSS_TIMEOUT_MS", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_MCP_DSS_TIMEOUT_MS = "60000";

    const config = await loadConfig();

    expect(config.ccs.dssTimeoutMs).toBe(60000);
  });

  test("defaults to the safe agent tool surface", async () => {
    delete process.env.C2000_MCP_CONFIG;
    delete process.env.C2000_MCP_TOOL_PROFILE;
    delete process.env.C2000_MCP_TOOL_SURFACE;

    const config = await loadConfig();

    expect(config.toolProfile).toBe("safe");
    expect(config.toolSurfaceProfile).toBe("agent");
  });

  test("loads and validates the tool surface environment override", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_MCP_TOOL_SURFACE = "advanced";

    const config = await loadConfig();

    expect(config.toolSurfaceProfile).toBe("advanced");
  });

  test("loads approved improvement implementation configuration without enabling it by default", async () => {
    delete process.env.C2000_MCP_CONFIG;
    delete process.env.C2000_MCP_IMPROVEMENT_ENABLED;
    delete process.env.C2000_MCP_IMPROVEMENT_AGENT_COMMAND;

    const config = await loadConfig();

    expect(config.improvement).toEqual(expect.objectContaining({
      enabled: false,
      baseRef: "master",
      maxActiveRuns: 1
    }));
    expect(config.improvement?.codingAgent.command).toBeUndefined();
    expect(config.improvement?.review).toEqual(expect.objectContaining({
      repository: "gjjisadog/C2000_Multicore_Debug_MCP",
      remote: "github",
      baseBranch: "master",
      revalidationPolicy: "on-significant-base-change"
    }));
  });

  test("loads controlled improvement review policy environment overrides", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_MCP_IMPROVEMENT_GITHUB_REPOSITORY = "gjjisadog/C2000_Multicore_Debug_MCP";
    process.env.C2000_MCP_IMPROVEMENT_GITHUB_REMOTE = "github";
    process.env.C2000_MCP_IMPROVEMENT_BASE_BRANCH = "master";
    process.env.C2000_MCP_IMPROVEMENT_REQUIRED_CHECKS_JSON = JSON.stringify(["host-tests"]);
    process.env.C2000_MCP_IMPROVEMENT_OPTIONAL_CHECKS_JSON = JSON.stringify(["hardware-evidence"]);
    process.env.C2000_MCP_IMPROVEMENT_REQUIRED_APPROVING_REVIEWS = "2";
    process.env.C2000_MCP_IMPROVEMENT_REQUIRE_HUMAN_REVIEW = "true";
    process.env.C2000_MCP_IMPROVEMENT_TRUSTED_REVIEWERS_JSON = JSON.stringify(["alice"]);
    process.env.C2000_MCP_IMPROVEMENT_REVALIDATION_POLICY = "on-base-change";

    const config = await loadConfig();

    expect(config.improvement?.review).toEqual(expect.objectContaining({
      requiredChecks: ["host-tests"],
      optionalChecks: ["hardware-evidence"],
      requiredApprovingReviews: 2,
      requireHumanReview: true,
      trustedReviewers: ["alice"],
      revalidationPolicy: "on-base-change"
    }));
  });

  test("loads approved improvement implementation environment overrides", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_MCP_IMPROVEMENT_ENABLED = "true";
    process.env.C2000_MCP_IMPROVEMENT_REPOSITORY_ROOT = "C:/approved/repository";
    process.env.C2000_MCP_IMPROVEMENT_WORKTREE_ROOT = "C:/approved/worktrees";
    process.env.C2000_MCP_IMPROVEMENT_ARTIFACT_ROOT = "C:/approved/artifacts";
    process.env.C2000_MCP_IMPROVEMENT_BASE_REF = "master";
    process.env.C2000_MCP_IMPROVEMENT_AGENT_PROVIDER = "test-agent";
    process.env.C2000_MCP_IMPROVEMENT_AGENT_COMMAND = "node";
    process.env.C2000_MCP_IMPROVEMENT_AGENT_ARGS_JSON = JSON.stringify(["agent.mjs", "{worktreePath}"]);

    const config = await loadConfig();

    expect(config.improvement).toEqual(expect.objectContaining({
      enabled: true,
      repositoryRoot: "C:/approved/repository",
      worktreeRoot: "C:/approved/worktrees",
      artifactRoot: "C:/approved/artifacts",
      baseRef: "master",
      codingAgent: expect.objectContaining({
        provider: "test-agent",
        command: "node",
        args: ["agent.mjs", "{worktreePath}"]
      })
    }));
  });

  test("rejects an invalid tool surface environment override", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_MCP_TOOL_SURFACE = "legacy-all";

    await expect(loadConfig()).rejects.toThrow(/toolSurfaceProfile|Invalid enum value/);
  });

  test("loads the cross-process probe queue and automatic recovery policy", async () => {
    process.env.C2000_MCP_PROBE_QUEUE_DIR = "/tmp/c2000-shared-probe";
    process.env.C2000_MCP_PROBE_QUEUE_TIMEOUT_MS = "120000";
    process.env.C2000_MCP_PROBE_RECOVERY_POLICY = "terminate-external";
    process.env.C2000_MCP_PROBES_JSON = JSON.stringify([
      { probeId: "board-01", serialNumber: "XDS-A", ccxmlPath: "/targets/a.ccxml", enabled: true },
      { probeId: "board-02", serialNumber: "XDS-B", ccxmlPath: "/targets/b.ccxml", enabled: true }
    ]);
    process.env.C2000_MCP_MULTI_BOARD_ENABLED = "true";

    const config = await loadConfig();

    expect(config.debugProbe).toEqual({
      queueDir: "/tmp/c2000-shared-probe",
      queueTimeoutMs: 120000,
      recoveryPolicy: "terminate-external",
      multiBoardEnabled: true,
      probes: [
        { probeId: "board-01", serialNumber: "XDS-A", ccxmlPath: "/targets/a.ccxml", enabled: true },
        { probeId: "board-02", serialNumber: "XDS-B", ccxmlPath: "/targets/b.ccxml", enabled: true }
      ]
    });
  });

  test("fills missing TI paths from validated discovery", async () => {
    delete process.env.C2000_MCP_CCS_INSTALL_PATH;
    delete process.env.C2000_MCP_C2000WARE_PATH;
    delete process.env.C2000_MCP_CCXML_PATH;
    const resolved: TiEnvironmentResolution = {
      ccs: { path: "/resolved/ccs", version: "21.0.0", source: "discovered", valid: true },
      c2000Ware: { path: "/resolved/C2000Ware", version: "26.1.0.0", source: "discovered", valid: true },
      ccxml: { path: "/resolved/target.ccxml", source: "derived", valid: true },
      attempts: []
    };

    const config = await loadConfig(undefined, { resolveTiEnvironment: async () => resolved });

    expect(config.ccs.installPath).toBe("/resolved/ccs");
    expect(config.ccs.c2000WarePath).toBe("/resolved/C2000Ware");
    expect(config.ccs.ccxmlPath).toBe("/resolved/target.ccxml");
  });

  test("environment overrides are passed as explicit discovery inputs", async () => {
    process.env.C2000_MCP_CCS_INSTALL_PATH = "/env/ccs";
    process.env.C2000_MCP_C2000WARE_PATH = "/env/C2000Ware";
    process.env.C2000_MCP_CCXML_PATH = "/env/target.ccxml";
    let received: unknown;

    await loadConfig(undefined, { resolveTiEnvironment: async (options = {}) => {
      received = options;
      return {
        ccs: { path: options.ccsInstallPath, source: "explicit", valid: true },
        c2000Ware: { path: options.c2000WarePath, source: "explicit", valid: true },
        ccxml: { path: options.ccxmlPath, source: "explicit", valid: true },
        attempts: []
      };
    } });

    expect(received).toMatchObject({
      ccsInstallPath: "/env/ccs",
      c2000WarePath: "/env/C2000Ware",
      ccxmlPath: "/env/target.ccxml"
    });
  });

  test("loads firmware program search roots from the environment", async () => {
    delete process.env.C2000_MCP_CONFIG;
    process.env.C2000_PROGRAM_SEARCH_ROOTS = ["/firmware/one", "/firmware/two"].join(path.delimiter);

    const config = await loadConfig(undefined, {
      resolveTiEnvironment: async () => ({
        ccs: { path: undefined, source: "unresolved", valid: false },
        c2000Ware: { path: undefined, source: "unresolved", valid: false },
        ccxml: { path: undefined, source: "unresolved", valid: false },
        attempts: []
      })
    });

    expect(config.programSearchRoots).toEqual(["/firmware/one", "/firmware/two"]);
  });
});

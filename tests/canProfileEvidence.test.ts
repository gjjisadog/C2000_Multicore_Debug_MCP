import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CanAcceptanceService } from "../src/can/CanAcceptanceService.js";
import { CanProfileRegistry } from "../src/can/CanProfileRegistry.js";
import { testPlanSchema } from "../src/jobs/TestPlanSchema.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { BoardGroupBarrierRepository } from "../src/storage/repositories/BoardGroupBarrierRepository.js";
import { BoardGroupRepository } from "../src/storage/repositories/BoardGroupRepository.js";
import { CanProfileRepository } from "../src/storage/repositories/CanProfileRepository.js";
import { CanTestResultRepository } from "../src/storage/repositories/CanTestResultRepository.js";
import { CanCampaignRepository } from "../src/storage/repositories/CanCampaignRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("versioned CAN profile evidence", () => {
  test("persists profile hash and performs only read-only safety/cross-board checks", async () => {
    const fixture = await makeFixture();
    const plan = testPlanSchema.parse(profilePlan("safety-ok"));
    fixture.runs.create({ jobId: "job-safety-ok", planName: plan.name, planVersion: 1, plan, status: "RUNNING", progressCurrent: 0, progressTotal: 2, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {} }, boardRuns("job-safety-ok"), []);
    const invoked: string[] = [];
    const service = fixture.service({
      async invokeTool(name, input) {
        invoked.push(name);
        if (name !== "c2000_evaluateMany") return { success: true };
        const expressions = (input as { expressions: string[] }).expressions;
        const values: Record<string, unknown> = { pwmTrip: true, contactorOpen: false, txCounter: 7, rxCounter: 7 };
        return { success: true, results: expressions.map(expression => ({ success: true, expression, value: values[expression] })) };
      }
    });
    service.prepare("job-safety-ok", plan, ["board-a", "board-b"]);
    await Promise.all(["board-a", "board-b"].map(boardId => service.execute({ jobId: "job-safety-ok", boardId, sessionId: `${boardId}-session`, leaseId: `${boardId}-lease`, plan, step: plan.steps[0]! })));

    const profile = fixture.profileRepository.list({ profileId: "safety-ok" })[0];
    expect(profile).toEqual(expect.objectContaining({ profileId: "safety-ok", version: 2, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    const group = fixture.groups.getByJob("job-safety-ok")!;
    expect(group).toEqual(expect.objectContaining({ status: "PASSED", profileId: "safety-ok", profileVersion: 2, profileHash: profile!.hash }));
    expect(fixture.results.list("job-safety-ok")).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "SAFETY", status: "PASSED" }),
      expect.objectContaining({ phase: "CROSS_BOARD", status: "PASSED" })
    ]));
    expect(invoked).toContain("c2000_evaluateMany");
    expect(invoked).not.toContain("c2000_assignExpression");
    expect(invoked).not.toContain("c2000_assignExpressions");
    fixture.store.close();
  });

  test("fails closed when a declared safety gate does not match", async () => {
    const fixture = await makeFixture();
    const plan = testPlanSchema.parse(profilePlan("safety-fail"));
    fixture.runs.create({ jobId: "job-safety-fail", planName: plan.name, planVersion: 1, plan, status: "RUNNING", progressCurrent: 0, progressTotal: 2, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {} }, boardRuns("job-safety-fail"), []);
    const invoked: string[] = [];
    const service = fixture.service({
      async invokeTool(name, input) {
        invoked.push(name);
        if (name !== "c2000_evaluateMany") return { success: true };
        const expressions = (input as { expressions: string[] }).expressions;
        return { success: true, results: expressions.map(expression => ({ success: true, expression, value: expression === "pwmTrip" ? false : false })) };
      }
    });
    service.prepare("job-safety-fail", plan, ["board-a", "board-b"]);
    await expect(Promise.all(["board-a", "board-b"].map(boardId => service.execute({ jobId: "job-safety-fail", boardId, sessionId: `${boardId}-session`, leaseId: `${boardId}-lease`, plan, step: plan.steps[0]! })))).rejects.toMatchObject({ code: "CanSafetyGateFailed" });
    expect(fixture.groups.getByJob("job-safety-fail")?.status).toBe("FAILED");
    expect(invoked).not.toContain("c2000_runCores");
    expect(invoked).not.toContain("c2000_assignExpression");
    fixture.store.close();
  });
});

async function makeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-profile-evidence-"));
  directories.push(directory);
  const store = await SqliteStore.open(path.join(directory, "debugd.sqlite"));
  const boards = new BoardRepository(store);
  for (const boardId of ["board-a", "board-b"]) boards.upsert({ boardId, probeSerial: `XDS-${boardId}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: [] });
  const groups = new BoardGroupRepository(store);
  const results = new CanTestResultRepository(store);
  const profileRepository = new CanProfileRepository(store);
  const profiles = new CanProfileRegistry(profileRepository);
  return {
    store, groups, results, runs: new TestRunRepository(store), profileRepository,
    service: (tools: { invokeTool: (name: string, input: unknown) => Promise<Record<string, unknown>> }) => new CanAcceptanceService({ groups, barriers: new BoardGroupBarrierRepository(store), profiles, campaigns: new CanCampaignRepository(store), results, events: new EventRepository(store), tools })
  };
}

function boardRuns(jobId: string) {
  return ["board-a", "board-b"].map(boardId => ({ jobId, boardId, probeSerial: `XDS-${boardId}`, status: "RUNNING", currentStepIndex: 0 }));
}

function profilePlan(profileId: string) {
  return {
    planVersion: 1,
    name: profileId,
    boardIds: ["board-a", "board-b"],
    can: { groupId: `group-${profileId}`, profile: {
      profileId, version: 2, adapter: "mock",
      roles: [{ role: "PRIMARY", boardId: "board-a", nodeId: 1 }, { role: "SECONDARY", boardId: "board-b", nodeId: 2 }],
      safety: { required: true, gates: [
        { name: "pwm-trip-latched", endpoint: { role: "PRIMARY", coreId: 0, expression: "pwmTrip" }, expected: true },
        { name: "contactor-open", endpoint: { role: "SECONDARY", coreId: 0, expression: "contactorOpen" }, expected: false }
      ] },
      comparisons: [{ name: "tx-rx-counters", left: { role: "PRIMARY", coreId: 0, expression: "txCounter" }, right: { role: "SECONDARY", coreId: 0, expression: "rxCounter" }, operator: "EQUAL" }],
      directions: [
        { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 0x301, data: [1] }] },
        { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 0x302, data: [2] }] }
      ],
      timeoutMs: 20, barrierTimeoutMs: 1000
    } },
    steps: [{ type: "canAcceptance" }]
  };
}

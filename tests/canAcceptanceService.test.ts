import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CanAcceptanceService } from "../src/can/CanAcceptanceService.js";
import { testPlanSchema } from "../src/jobs/TestPlanSchema.js";
import { BoardRepository } from "../src/storage/repositories/BoardRepository.js";
import { BoardGroupRepository } from "../src/storage/repositories/BoardGroupRepository.js";
import { CanTestResultRepository } from "../src/storage/repositories/CanTestResultRepository.js";
import { EventRepository } from "../src/storage/repositories/EventRepository.js";
import { TestRunRepository } from "../src/storage/repositories/TestRunRepository.js";
import { SqliteStore } from "../src/storage/SqliteStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("two-board CAN acceptance service", () => {
  test("persists a CAN pair and proves both directions through the mock bus with cross-board observations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-can-test-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "debugd.sqlite"));
    const boards = new BoardRepository(store);
    for (const boardId of ["board-a", "board-b"]) {
      boards.upsert({ boardId, probeSerial: `CL65-${boardId}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: ["can"] });
    }
    const runs = new TestRunRepository(store);
    const jobId = "run-can-unit";
    const plan = testPlanSchema.parse({
      planVersion: 1,
      name: "mock-can-pair",
      boardIds: ["board-a", "board-b"],
      can: {
        groupId: "can-group-unit",
        profile: {
          adapter: "mock",
          directions: [
            { sourceBoardId: "board-a", targetBoardId: "board-b", frames: [{ id: 0x101, data: [1, 2] }] },
            { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 0x102, data: [3, 4] }] }
          ],
          observations: [
            { boardId: "board-a", coreId: 0, expressions: [{ expression: "canTxCount", expected: 1 }] },
            { boardId: "board-b", coreId: 0, expressions: [{ expression: "canRxCount", expected: 1 }] }
          ],
          timeoutMs: 50,
          barrierTimeoutMs: 500
        }
      },
      steps: [{ type: "canAcceptance" }]
    });
    runs.create(
      { jobId, planName: plan.name, planVersion: 1, plan, status: "RUNNING", progressCurrent: 0, progressTotal: 2, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {} },
      [
        { jobId, boardId: "board-a", probeSerial: "CL65-board-a", status: "RUNNING", currentStepIndex: 0 },
        { jobId, boardId: "board-b", probeSerial: "CL65-board-b", status: "RUNNING", currentStepIndex: 0 }
      ],
      []
    );
    const invoked: string[] = [];
    const service = new CanAcceptanceService({
      groups: new BoardGroupRepository(store), results: new CanTestResultRepository(store), events: new EventRepository(store),
      tools: {
        async invokeTool(name, input) {
          invoked.push(name);
          if (name === "c2000_evaluateMany") {
            const expressions = (input as { expressions: string[] }).expressions;
            return { success: true, results: expressions.map(expression => ({ expression, value: 1 })) };
          }
          return { success: true };
        }
      }
    });
    service.prepare(jobId, plan, ["board-a", "board-b"]);

    const [left, right] = await Promise.all(["board-a", "board-b"].map(boardId => service.execute({
      jobId, boardId, sessionId: `${boardId}-session`, plan, step: plan.steps[0]!
    })));

    expect(left).toEqual(expect.objectContaining({ success: true, simulation: true, groupId: "can-group-unit" }));
    expect(right).toEqual(expect.objectContaining({ success: true, directions: expect.arrayContaining([
      expect.objectContaining({ direction: { sourceBoardId: "board-a", targetBoardId: "board-b" } }),
      expect.objectContaining({ direction: { sourceBoardId: "board-b", targetBoardId: "board-a" } })
    ]) }));
    expect(invoked.filter(name => name === "c2000_runCores")).toHaveLength(2);
    expect(invoked.filter(name => name === "c2000_evaluateMany")).toHaveLength(2);
    expect(new CanTestResultRepository(store).list(jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "BARRIER", status: "PASSED" }),
      expect.objectContaining({ phase: "DIRECTION", status: "PASSED" }),
      expect.objectContaining({ phase: "OBSERVABILITY", status: "PASSED" })
    ]));
    expect(new BoardGroupRepository(store).require("can-group-unit").status).toBe("READY");
    store.close();
  });

  test("verifies an intentional one-way frame drop without treating it as delivery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "c2000-can-drop-"));
    directories.push(directory);
    const store = await SqliteStore.open(path.join(directory, "debugd.sqlite"));
    const boards = new BoardRepository(store);
    for (const boardId of ["board-a", "board-b"]) boards.upsert({ boardId, probeSerial: `CL65-${boardId}`, device: "F28P65x", ccxmlPath: `${boardId}.ccxml`, tags: [] });
    const jobId = "run-can-drop";
    const plan = testPlanSchema.parse({
      planVersion: 1, name: "mock-can-drop", boardIds: ["board-a", "board-b"],
      can: { groupId: "can-group-drop", profile: {
        adapter: "mock", timeoutMs: 20, barrierTimeoutMs: 500,
        faults: [{ name: "drop-a-to-b", kind: "drop", sourceBoardId: "board-a", targetBoardId: "board-b" }],
        directions: [
          { sourceBoardId: "board-a", targetBoardId: "board-b", expectDelivery: false, frames: [{ id: 1, data: [] }] },
          { sourceBoardId: "board-b", targetBoardId: "board-a", frames: [{ id: 2, data: [] }] }
        ]
      } },
      steps: [{ type: "canAcceptance" }]
    });
    new TestRunRepository(store).create(
      { jobId, planName: plan.name, planVersion: 1, plan, status: "RUNNING", progressCurrent: 0, progressTotal: 2, submittedAt: new Date().toISOString(), cancelRequested: false, failurePolicy: {} },
      [
        { jobId, boardId: "board-a", probeSerial: "CL65-board-a", status: "RUNNING", currentStepIndex: 0 },
        { jobId, boardId: "board-b", probeSerial: "CL65-board-b", status: "RUNNING", currentStepIndex: 0 }
      ], []
    );
    const service = new CanAcceptanceService({
      groups: new BoardGroupRepository(store), results: new CanTestResultRepository(store), events: new EventRepository(store), tools: { async invokeTool() { return { success: true }; } }
    });
    service.prepare(jobId, plan, ["board-a", "board-b"]);
    const results = await Promise.all(["board-a", "board-b"].map(boardId => service.execute({ jobId, boardId, sessionId: boardId, plan, step: plan.steps[0]! })));
    expect(results[0]).toEqual(expect.objectContaining({ success: true, captures: expect.arrayContaining([expect.objectContaining({ delivery: "DROPPED", fault: "drop-a-to-b" })]) }));
    store.close();
  });
});

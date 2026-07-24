import { z } from "zod";

const canFrameSchema = z.object({
  id: z.number().int().min(0).max(0x1fffffff),
  data: z.array(z.number().int().min(0).max(0xff)).max(8),
  extended: z.boolean().default(false)
});

const canDirectionSchema = z.object({
  sourceBoardId: z.string().min(1),
  targetBoardId: z.string().min(1),
  frames: z.array(canFrameSchema).min(1),
  /** A false expectation is used for intentional-loss fault tests. */
  expectDelivery: z.boolean().default(true)
});

export const canFaultScenarioSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["drop", "delay", "bus_off"]),
  sourceBoardId: z.string().min(1).optional(),
  targetBoardId: z.string().min(1).optional(),
  everyNth: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional()
});

const observationValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const canObservationSchema = z.object({
  boardId: z.string().min(1),
  coreId: z.number().int(),
  expressions: z.array(z.object({
    expression: z.string().min(1),
    expected: observationValueSchema.optional()
  })).min(1)
});

export const canAcceptanceProfileSchema = z.object({
  /** Hardware is the safe default: it fails closed until a physical adapter is configured. */
  adapter: z.enum(["hardware", "mock"]).default("hardware"),
  directions: z.array(canDirectionSchema).min(2),
  faults: z.array(canFaultScenarioSchema).default([]),
  observations: z.array(canObservationSchema).default([]),
  autoRunCores: z.boolean().default(true),
  runCoreIds: z.array(z.number().int()).min(1).default([0, 2]),
  barrierTimeoutMs: z.number().int().positive().default(15000),
  timeoutMs: z.number().int().positive().default(5000)
});

export type CanAcceptanceProfile = z.infer<typeof canAcceptanceProfileSchema>;
export type CanFaultScenario = z.infer<typeof canFaultScenarioSchema>;

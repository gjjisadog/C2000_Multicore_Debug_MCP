import { z } from "zod";

export const HARDWARE_ACCEPTANCE_SCHEMA_VERSION = 1 as const;

export const hardwareAcceptanceStatusSchema = z.enum([
  "PASS_HARDWARE",
  "FAIL_HARDWARE",
  "SKIPPED_NO_HARDWARE",
  "SKIPPED_UNSUPPORTED",
  "INCONCLUSIVE",
  "PASS_MOCK"
]);

export const hardwareEvidenceLevelSchema = z.enum([
  "SIMULATION_EVIDENCE",
  "HOST_COMMAND_EVIDENCE",
  "TARGET_STATE_EVIDENCE",
  "BUS_EVIDENCE",
  "FULL_HARDWARE_EVIDENCE"
]);

export const hardwareAcceptanceScopeSchema = z.enum([
  "single-board",
  "multicore",
  "variables",
  "dlog",
  "erad",
  "trace",
  "can",
  "two-board",
  "soak",
  "all"
]);

export const hardwareAcceptanceCaseSchema = z.object({
  caseId: z.string().min(1),
  scope: hardwareAcceptanceScopeSchema.exclude(["all"]),
  title: z.string().min(1),
  status: hardwareAcceptanceStatusSchema,
  evidenceLevel: hardwareEvidenceLevelSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  reason: z.string().min(1).nullable(),
  boardIds: z.array(z.string().min(1)),
  coreIdentities: z.array(z.object({
    coreId: z.number().int().nonnegative(),
    coreName: z.string().min(1)
  })),
  evidencePaths: z.array(z.string().min(1)),
  details: z.record(z.unknown())
});

export const hardwareAcceptanceEnvironmentSchema = z.object({
  windowsVersion: z.string().min(1),
  architecture: z.string().min(1),
  nodeVersion: z.string().min(1),
  repositoryCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  packageVersion: z.string().min(1),
  ccsVersion: z.string().nullable(),
  dssVersion: z.string().nullable(),
  xds110Serials: z.array(z.string().min(1)),
  pcan: z.object({
    model: z.string().nullable(),
    channel: z.string().nullable(),
    driverVersion: z.string().nullable()
  }),
  firmwareCommitSha: z.string().nullable(),
  operator: z.string().nullable(),
  testDate: z.string().datetime()
});

export const hardwareAcceptanceResultSchema = z.object({
  schemaVersion: z.literal(HARDWARE_ACCEPTANCE_SCHEMA_VERSION),
  runId: z.string().min(1),
  selectedScope: hardwareAcceptanceScopeSchema,
  overallStatus: hardwareAcceptanceStatusSchema,
  environment: hardwareAcceptanceEnvironmentSchema,
  optIn: z.object({
    hardware: z.boolean(),
    pcan: z.boolean(),
    twoBoard: z.boolean()
  }),
  safety: z.object({
    highVoltageBusConnected: z.literal(false),
    powerStageDriven: z.literal(false),
    pwmAutomaticallyEnabled: z.literal(false),
    tripAutomaticallyReleased: z.literal(false),
    protectionThresholdsModified: z.literal(false),
    unknownFirmwareAllowed: z.literal(false)
  }),
  cases: z.array(hardwareAcceptanceCaseSchema),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  completeness: z.enum(["COMPLETE", "INCOMPLETE"])
});

export const hardwareAcceptanceEventSchema = z.object({
  schemaVersion: z.literal(HARDWARE_ACCEPTANCE_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  runId: z.string().min(1),
  eventType: z.string().min(1),
  timestamp: z.string().datetime(),
  monotonicTimestampNs: z.string().regex(/^\d+$/),
  scope: hardwareAcceptanceScopeSchema,
  caseId: z.string().nullable(),
  payload: z.record(z.unknown())
});

export const hardwareAcceptanceManifestSchema = z.object({
  schemaVersion: z.literal(HARDWARE_ACCEPTANCE_SCHEMA_VERSION),
  runId: z.string().min(1),
  selectedScope: hardwareAcceptanceScopeSchema,
  resultPath: z.string().min(1),
  eventsPath: z.string().min(1),
  reportPath: z.string().min(1),
  generatedFiles: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative()
  })),
  completeness: z.enum(["COMPLETE", "INCOMPLETE"]),
  incompleteReason: z.string().min(1).nullable()
});

export type HardwareAcceptanceScope = z.infer<typeof hardwareAcceptanceScopeSchema>;
export type HardwareAcceptanceCase = z.infer<typeof hardwareAcceptanceCaseSchema>;
export type HardwareAcceptanceResult = z.infer<typeof hardwareAcceptanceResultSchema>;
export type HardwareAcceptanceEvent = z.infer<typeof hardwareAcceptanceEventSchema>;

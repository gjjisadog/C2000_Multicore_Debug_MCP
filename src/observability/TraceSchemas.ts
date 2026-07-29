import { z } from "zod";

export const TRACE_SCHEMA_VERSION = 1 as const;
export const FAILURE_BUNDLE_SCHEMA_VERSION = 1 as const;

export const traceIncludeSchema = z.enum([
  "job-events",
  "lease-events",
  "worker-events",
  "dss-events",
  "target-state",
  "can-evidence",
  "variables",
  "erad",
  "dlog"
]);

export const exportTraceSchema = z.object({
  jobId: z.string().min(1),
  include: z.array(traceIncludeSchema).min(1).default([
    "job-events",
    "lease-events",
    "worker-events",
    "dss-events",
    "target-state",
    "can-evidence",
    "variables",
    "erad",
    "dlog"
  ]),
  format: z.literal("perfetto").default("perfetto"),
  source: z.enum(["auto", "sqlite", "artifacts"]).default("auto")
});

export const collectFailureBundleSchema = z.object({
  jobId: z.string().min(1),
  reason: z.string().min(1).optional(),
  recentEventLimit: z.number().int().positive().max(10_000).default(500),
  itemTimeoutMs: z.number().int().positive().max(30_000).default(2_000),
  totalTimeoutMs: z.number().int().positive().max(120_000).default(15_000),
  includeTrace: z.boolean().default(true)
});

export const traceTimeDomainSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "host-monotonic",
    "host-wall-clock",
    "pcan-host",
    "pcan-hardware",
    "mcu-counter",
    "mcu-sample-index",
    "erad-cycle",
    "dlog-relative"
  ]),
  unit: z.string().min(1),
  synchronizedToHost: z.boolean(),
  calibration: z.record(z.unknown()).nullable()
});

export const perfettoTraceEventSchema = z.object({
  name: z.string().min(1),
  cat: z.string().min(1),
  ph: z.enum(["M", "i", "X", "C"]),
  ts: z.number().finite().nonnegative(),
  pid: z.number().int().positive(),
  tid: z.number().int().positive(),
  s: z.enum(["t", "p", "g"]).optional(),
  dur: z.number().finite().nonnegative().optional(),
  args: z.record(z.unknown()).default({})
});

export const traceDocumentSchema = z.object({
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  format: z.literal("perfetto-trace-event-json"),
  displayTimeUnit: z.literal("ms"),
  jobId: z.string().min(1),
  generatedFrom: z.array(z.enum(["sqlite", "artifacts"])).min(1),
  primaryTimeDomain: z.literal("host-monotonic"),
  timeDomains: z.array(traceTimeDomainSchema),
  tracks: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    pid: z.number().int().positive(),
    tid: z.number().int().positive(),
    timeDomain: z.string().min(1)
  })),
  traceEvents: z.array(perfettoTraceEventSchema),
  missingSources: z.array(z.string()),
  incompleteSources: z.array(z.string()),
  completeness: z.enum(["COMPLETE", "INCOMPLETE"])
});

export type ExportTraceInput = z.infer<typeof exportTraceSchema>;
export type CollectFailureBundleInput = z.infer<typeof collectFailureBundleSchema>;
export type TraceDocument = z.infer<typeof traceDocumentSchema>;
export type PerfettoTraceEvent = z.infer<typeof perfettoTraceEventSchema>;

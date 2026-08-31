# Engineering Verification

The verification layer sits above the existing stdio proxy → daemon → worker
architecture. It is host-observable and deterministic; it does not own boards,
leases, workers, CCS sessions, or target jobs and it never calls an LLM.

## Workflow and tools

`c2000_runEngineeringVerification` is the preferred one-call workflow. It
creates a parent `verificationId` and related child ids:

```text
V123
├── V123/build
├── V123/map
├── V123/regression
└── V123/review
```

The atomic tools are available for focused work:

| Tool | Deterministic responsibility | Target access |
|---|---|---|
| `c2000_verifyBuild` | trusted provider/log diagnostics and build identity | none |
| `c2000_verifyMap` | TI C2000 map parsing, metrics, hard gates, freshness | none |
| `c2000_verifyRegression` | declared host/mock suites and complete logs | none by default |
| `c2000_verifyReview` | diff metadata, path/pattern/companion rules | none |
| `c2000_getVerificationResult` | read persisted result/manifest | none |

Build providers are selected by installation-time configuration. A configured
process provider has a fixed executable, arguments, working directory, and
timeout; a request cannot submit arbitrary shell text. The default `artifact`
provider inspects a supplied build log. Git, Python, CCS, and network access
are not required for the verifier core.

## Result and evidence

Every result uses `src/verification/VerificationSchemas.ts` and records
status, subject, identity, inputs, checks, metrics, diagnostics, artifacts,
evidence classification, completeness, and hard-gate failures. Statuses are
`PASSED`, `FAILED`, `BLOCKED`, `UNSUPPORTED`, and `ERROR`; individual checks
also support `SKIPPED`.

Results are atomically persisted as `result.json`, `verification.json`,
`metrics.json`, logs/evidence, and a last-written `manifest.json`. Metrics are
serialized using the existing deterministic run-metrics contract so map
metrics such as `flash.used`, region utilization, CLA utilization, and
`stack.static.bytes` can participate in the existing baseline approach. Static
`.stack` allocation is not runtime high-water usage.

For a real durable job, `jobId` is an optional correlation field and generated
files may be registered in the existing artifact repository. A host-only
verification uses its own id and is never represented as a second target job.

## Hard gates and freshness

Build diagnostics, missing required artifacts, map parse incompleteness, region
utilization, required sections, forbidden placements, section growth, review
requirements, and required regression failures are structured facts. A hard
failure rejects; incomplete or required unsupported evidence blocks. There is
no score average that can hide a critical failure.

The suite never analyzes a map after a failed current build. A map linked to a
build must match path, SHA-256, mtime, and build identity metadata. Old `.map`
or `.out` files cannot turn a new source revision into a pass.

Regression defaults to host-only. A hardware suite requires
`requireHardware=true` and an explicit durable runner; the verification layer
does not bypass board registration, permits, leases, fencing, worker identity,
allowed roots, or safety guards. Mock results remain `MOCK` evidence.

Review accepts `diffText`, `diffPath`, or `changedFiles[]`; it does not require
Git. Configured realtime, linker, CPU/CLA interface, and IPC paths require
linked evidence ids. Missing proof is a block/review requirement, not a
natural-language guess.

Configuration lives under `verification` in the normal config and is additive:

```json
{
  "verification": {
    "build": { "enabled": true, "defaultProvider": "artifact" },
    "map": { "enabled": true, "rules": { "maxRegionUtilization": { "RAMLS0": 95 } } },
    "regression": { "enabled": true },
    "review": { "enabled": true }
  }
}
```

For project-specific thresholds, set `verification.rulesFile` to a JSON file
inside `allowedReadRoots`. The file is schema-checked and merged with the
installation config before a verification run; request-level rules override
the file for that run. It can contain `build.defaultProvider`, `map.rules`,
`regression.plan`, and `review.rules`.

Input paths continue through `allowedReadRoots`/`allowedWriteRoots`.

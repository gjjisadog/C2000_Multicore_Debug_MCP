# CLA task timing record

`c2000_readClaTaskTiming` reports a CLA task's elapsed timer cycles and seconds
from a firmware-maintained shared-memory record. It does not use ERAD PC
comparators to observe CLA execution. On F28P65x, the timing probes must be in
the CLA firmware; this MCP operation only resolves and reads the record.
Accordingly, `c2000_getEradCapabilities.supportsClaTaskTiming` remains `false`:
that field describes native ERAD timing support, not this firmware-instrumented
reader.

## Firmware record contract

Define one record per timed task in memory visible to the CPU, preferably the
CLA-to-CPU message RAM region configured by the linker. Define the shared
object in a `.c`/`.cpp` translation unit (not a `.cla` file) and keep all fields
as 32-bit unsigned values so the reader can resolve each field independently:

```c
typedef struct {
    volatile uint32_t sequence;       // odd while updating; even when stable
    volatile uint32_t taskNumber;     // CLA task number, 1..8
    volatile uint32_t count;          // completed samples
    volatile uint32_t lastCycles;
    volatile uint32_t totalCyclesLow; // low 32 bits of exact accumulated cycles
    volatile uint32_t totalCyclesHigh;// high 32 bits of exact accumulated cycles
    volatile uint32_t minCycles;
    volatile uint32_t maxCycles;
    volatile uint32_t overflowCount;  // samples known to be ambiguous/inaccurate
} ClaTaskTimingRecord;
```

At the earliest practical point in the task, increment `sequence` to odd and
read the free-running timer. Read it again as late as practical before the
task returns, compute elapsed cycles, update the statistics, then increment
`sequence` to even. The reader accepts a snapshot only when the same even
sequence value brackets all field reads. Keep the task's own writer exclusive
to that task's record.

For an ePWM `TBCTR` source, configure an up-counting free-running counter and
use `timerPeriodCycles = TBPRD + 1`; set `timerHz` to the actual TBCLK after
the ePWM clock dividers. For a single-wrap modulo delta:

```c
uint32_t elapsed = end >= start
    ? (uint32_t)(end - start)
    : (uint32_t)(timerPeriodCycles - start + end);
```

This is unambiguous only when one task interval is shorter than the timer
period. If that cannot be guaranteed, use a wider timer or a firmware overflow
extension and increment `overflowCount` whenever a duration cannot be recovered
exactly. Update the 64-bit total using the low-word carry into the high word;
increment `overflowCount` if the high word or sample count itself would wrap.
Keep `sequence` even before the task starts and initialize the remaining record
fields to zero (`minCycles` can be set on its first completed sample). A record
with `count == 0` or nonzero `overflowCount` is reported as incomplete.

The reported interval starts at the first timer read inside the task and ends
at the last timer read before task exit. It excludes trigger-to-task-start
latency and the instructions outside those timer reads; higher-priority CLA
work that preempts the task contributes to elapsed time. The reader itself
performs target memory reads, so avoid rapid polling during sensitive real-time
measurements.

## MCP request

The record symbol must name the shared structure object (not a pointer):

```json
{
  "boardId": "board-id",
  "sessionId": "session-id",
  "coreId": 0,
  "taskNumber": 1,
  "recordSymbol": "claTask1Timing",
  "timerSource": "EPWM1.TBCTR",
  "timerHz": 100000000,
  "timerPeriodCycles": 65536,
  "snapshotAttempts": 5
}
```

The response contains exact `totalCycles` as a decimal string, plus last/min/max/
mean cycles, seconds, sample count, overflow count, firmware hashes when known,
and a completeness classification. The timer source and frequency are supplied
by the caller because the record cannot prove the target timer's configuration.

TI's [CLA FAQ](https://software-dl.ti.com/C2000/docs/cla_software_dev_guide/faq.html#how-can-i-measure-the-duration-of-a-task)
describes timer reads at task entry and exit (and GPIO measurement as an
alternative). See also TI's [CLA communication guide](https://software-dl.ti.com/C2000/docs/C2000_Multicore_Development_User_Guide/cla_communication.html)
for CPU/CLA shared-memory constraints.

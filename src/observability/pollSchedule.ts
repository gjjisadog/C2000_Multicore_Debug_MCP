export interface ClaimedPollSlot {
  scheduledStartNs: bigint;
  nextPollNs: bigint;
  missedPollCount: number;
  schedulingLatenessNs: bigint;
}

/**
 * Claims exactly one slot from an absolute monotonic schedule.
 *
 * A late poll skips only fully elapsed slots, then resumes at the newest slot
 * that can still be sampled. The next deadline remains anchored to the
 * original schedule instead of drifting by the duration of DSS or persistence
 * work.
 */
export function claimPollSlot(actualStartNs: bigint, nextPollNs: bigint, periodNs: bigint): ClaimedPollSlot {
  if (periodNs <= 0n) throw new RangeError("periodNs must be positive");
  const latenessFromNextNs = actualStartNs > nextPollNs ? actualStartNs - nextPollNs : 0n;
  const missedPollCount = Number(latenessFromNextNs / periodNs);
  const scheduledStartNs = nextPollNs + BigInt(missedPollCount) * periodNs;
  return {
    scheduledStartNs,
    nextPollNs: scheduledStartNs + periodNs,
    missedPollCount,
    schedulingLatenessNs: actualStartNs > scheduledStartNs ? actualStartNs - scheduledStartNs : 0n
  };
}

/**
 * Normalize CCS expression addresses to the hexadecimal form used by the
 * observability schemas. CCS may return either `0x...` or a decimal C28x
 * address depending on the expression formatter.
 */
export function normalizeTargetAddress(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  const hexadecimal = raw.match(/0x[0-9a-f]+/i);
  if (hexadecimal) return hexadecimal[0].toLowerCase();
  if (!/^\d+$/.test(raw)) return undefined;
  return `0x${BigInt(raw).toString(16)}`;
}

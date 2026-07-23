/** Compare evaluated expression values against expected wait/assign targets. */
export function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) {
    return expected === undefined || expected === null;
  }
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }
  if (typeof expected === "boolean") {
    const text = String(actual).trim().toLowerCase();
    if (expected) {
      return text === "true" || text === "1";
    }
    return text === "false" || text === "0";
  }
  const actualText = String(actual).trim();
  const expectedText = String(expected).trim();
  if (actualText === expectedText) {
    return true;
  }
  const actualNumber = Number(actualText);
  const expectedNumber = Number(expectedText);
  if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
    return actualNumber === expectedNumber;
  }
  return actualText.toLowerCase() === expectedText.toLowerCase();
}

/** True when an expression evaluation looks "non-zero / ready" for boot handoff heuristics. */
export function expressionLooksReady(result: { success?: boolean; value?: unknown } | undefined): boolean {
  if (!result || result.success !== true) {
    return false;
  }
  const text = String(result.value ?? "").trim().toLowerCase();
  if (text === "" || text === "undefined" || text === "null" || text === "nan" || text === "false") {
    return false;
  }
  if (text === "0" || text === "0.0" || text === "0x0" || text === "0x00" || text === "0x00000000") {
    return false;
  }
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber === 0) {
    return false;
  }
  return true;
}

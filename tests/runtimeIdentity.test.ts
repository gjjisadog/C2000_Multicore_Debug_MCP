import { describe, expect, test } from "vitest";
import { compareRuntimeBuildIdentity, type RuntimeBuildIdentity } from "../src/contracts/RuntimeIdentity.js";

const base: RuntimeBuildIdentity = {
  version: "0.7.1",
  sourceRevision: "abc123",
  sourceDirty: false,
  builtAt: "2026-09-21T00:00:00.000Z",
  devBuildId: "new-source"
};

describe("runtime build identity", () => {
  test("treats a development source fingerprint change as incompatible", () => {
    const result = compareRuntimeBuildIdentity(base, { ...base, devBuildId: "old-source" }, { development: true });
    expect(result.compatible).toBe(false);
    expect(result.mismatches).toEqual(["devBuildId"]);
  });

  test("treats an explicit release source revision change as incompatible", () => {
    const result = compareRuntimeBuildIdentity(base, { ...base, sourceRevision: "def456" }, { development: false });
    expect(result.compatible).toBe(false);
    expect(result.mismatches).toEqual(["sourceRevision"]);
  });

  test("does not treat build timestamps as compatibility identity", () => {
    const result = compareRuntimeBuildIdentity(base, { ...base, builtAt: "2026-09-22T00:00:00.000Z" }, { development: false });
    expect(result.compatible).toBe(true);
  });
});

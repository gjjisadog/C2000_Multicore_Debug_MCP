import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AcceptanceClosureService } from "../src/artifacts/AcceptanceClosureService.js";
import type { ArtifactRepository } from "../src/storage/repositories/ArtifactRepository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("detached acceptance closure", () => {
  test("binds canonical artifacts and offline reports without a manifest cycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-acceptance-closure-"));
    roots.push(root);
    const jobId = "run-closure-test";
    const jobDirectory = path.join(root, jobId);
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({ generatedFiles: [] }));
    await writeFile(path.join(jobDirectory, "result.json"), JSON.stringify({ overallStatus: "PASSED" }));
    await writeFile(path.join(jobDirectory, "expression-snapshots.json"), JSON.stringify({ snapshots: [] }));
    const offlineJsonPath = path.join(root, "offline.json");
    const offlineCsvPath = path.join(root, "offline.csv");
    const offlineMarkdownPath = path.join(root, "offline.md");
    await writeFile(offlineJsonPath, "{\"verdict\":\"PASS\"}\n");
    await writeFile(offlineCsvPath, "case,status\nA,PASS\n");
    await writeFile(offlineMarkdownPath, "# Current HEAD closure\n");
    const upsert = vi.fn(() => "artifact-closure");
    const artifacts = { upsert } as unknown as ArtifactRepository;
    const service = new AcceptanceClosureService({ rootDirectory: root, artifacts });

    const created = await service.create({ jobId, offlineJsonPath, offlineCsvPath, offlineMarkdownPath });

    expect(created).toEqual(expect.objectContaining({
      success: true,
      jobId,
      closurePath: path.join(jobDirectory, "acceptance-closure.json"),
      artifactId: "artifact-closure",
      verification: expect.objectContaining({ valid: true, selfHashMatched: true, boundFilesMatched: true, baseManifestUnchanged: true })
    }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ jobId, artifactType: "acceptance:detached-closure" }));
    await expect(service.verify(path.join(jobDirectory, "acceptance-closure.json"))).resolves.toEqual(expect.objectContaining({ valid: true }));

    await writeFile(offlineCsvPath, "case,status\nA,CHANGED\n");
    await expect(service.verify(path.join(jobDirectory, "acceptance-closure.json"))).resolves.toEqual(expect.objectContaining({ valid: false, selfHashMatched: true, boundFilesMatched: false }));
  });

  test("rejects a closure path already referenced by the canonical manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-acceptance-closure-cycle-"));
    roots.push(root);
    const jobId = "run-closure-cycle";
    const jobDirectory = path.join(root, jobId);
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({ generatedFiles: [{ path: "acceptance-closure.json" }] }));
    await writeFile(path.join(jobDirectory, "result.json"), "{}");
    await writeFile(path.join(jobDirectory, "expression-snapshots.json"), "{}");
    const offlineJsonPath = path.join(root, "offline.json");
    const offlineCsvPath = path.join(root, "offline.csv");
    const offlineMarkdownPath = path.join(root, "offline.md");
    await Promise.all([
      writeFile(offlineJsonPath, "{}"),
      writeFile(offlineCsvPath, ""),
      writeFile(offlineMarkdownPath, "")
    ]);
    const service = new AcceptanceClosureService({
      rootDirectory: root,
      artifacts: { upsert: () => "unused" } as unknown as ArtifactRepository
    });

    await expect(service.create({ jobId, offlineJsonPath, offlineCsvPath, offlineMarkdownPath })).rejects.toThrow("AcceptanceClosureCircularReference");
  });

  test("detects tampering with the attestation itself", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2000-acceptance-closure-self-"));
    roots.push(root);
    const jobId = "run-closure-self";
    const jobDirectory = path.join(root, jobId);
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify({ generatedFiles: [] }));
    await writeFile(path.join(jobDirectory, "result.json"), "{}");
    await writeFile(path.join(jobDirectory, "expression-snapshots.json"), "{}");
    const offlineJsonPath = path.join(root, "offline.json");
    const offlineCsvPath = path.join(root, "offline.csv");
    const offlineMarkdownPath = path.join(root, "offline.md");
    await Promise.all([writeFile(offlineJsonPath, "{}"), writeFile(offlineCsvPath, ""), writeFile(offlineMarkdownPath, "")]);
    const service = new AcceptanceClosureService({ rootDirectory: root, artifacts: { upsert: () => "unused" } as unknown as ArtifactRepository });
    await service.create({ jobId, offlineJsonPath, offlineCsvPath, offlineMarkdownPath });
    const closurePath = path.join(jobDirectory, "acceptance-closure.json");
    const record = JSON.parse(await readFile(closurePath, "utf8")) as Record<string, unknown>;
    record.attestationSha256 = "0".repeat(64);
    await writeFile(closurePath, `${JSON.stringify(record)}\n`);
    await expect(service.verify(closurePath)).resolves.toEqual(expect.objectContaining({ valid: false, selfHashMatched: false }));
  });
});

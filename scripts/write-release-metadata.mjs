import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const files = (await readdir(process.cwd())).filter(name => name.endsWith(".tgz"));
files.push("dist/src/runtime-manifest.json", "sbom.cdx.json");
const hashes = [];
for (const file of files) {
  const content = await readFile(file);
  hashes.push({ target, file, sha256: createHash("sha256").update(content).digest("hex"), size: content.length });
}
await writeFile("SHA256SUMS.json", `${JSON.stringify({ target, generatedAt: new Date().toISOString(), files: hashes }, null, 2)}\n`);

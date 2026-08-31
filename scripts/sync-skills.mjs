#!/usr/bin/env node
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = path.join(projectRoot, "skills");
const mirrorRoot = path.join(projectRoot, ".skills");
const checkOnly = process.argv.includes("--check");

async function filesUnder(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else files.push(child.replaceAll(path.sep, "/"));
  }
  return files;
}

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const canonicalFiles = await filesUnder(canonicalRoot);
const mismatches = [];
for (const relative of canonicalFiles) {
  const source = path.join(canonicalRoot, relative);
  const mirror = path.join(mirrorRoot, relative);
  try {
    if (await digest(source) !== await digest(mirror)) mismatches.push(relative);
  } catch {
    mismatches.push(relative);
  }
}

if (checkOnly) {
  if (mismatches.length > 0) {
    console.error(`Skill mirror is out of sync: ${mismatches.join(", ")}`);
    process.exit(1);
  }
  console.log(`Skill mirror is synchronized (${canonicalFiles.length} canonical files).`);
} else {
  await mkdir(mirrorRoot, { recursive: true });
  await cp(canonicalRoot, mirrorRoot, { recursive: true, force: true });
  console.log(`Synchronized ${canonicalFiles.length} canonical skill files into .skills/.`);
}

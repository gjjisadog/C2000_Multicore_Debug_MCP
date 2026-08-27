import Database from "better-sqlite3";
import { resolveSqliteNativeBinding } from "../storage/SqliteStore.js";

const nativeBinding = resolveSqliteNativeBinding();
const database = nativeBinding
  ? new Database(":memory:", { nativeBinding })
  : new Database(":memory:");
database.exec("CREATE TABLE runtime_check (value INTEGER NOT NULL); INSERT INTO runtime_check VALUES (1);");
const row = database.prepare("SELECT value FROM runtime_check").get() as { value?: number } | undefined;
database.close();

if (row?.value !== 1) {
  throw new Error("better-sqlite3 :memory: verification returned an unexpected value");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  sqliteMemory: true,
  nodeVersion: process.version,
  nodeModulesAbi: process.versions.modules,
  platform: process.platform,
  arch: process.arch
})}\n`);

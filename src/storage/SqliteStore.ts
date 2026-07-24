import { mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase } from "./DatabaseMigrator.js";

/** The sole SQLite driver boundary. Repositories are the only higher-level SQL callers. */
export class SqliteStore {
  private constructor(private readonly database: Database.Database, readonly databasePath: string) {}

  static async open(databasePath: string, options: { wal?: boolean } = {}): Promise<SqliteStore> {
    const resolvedPath = path.resolve(databasePath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const database = new Database(resolvedPath);
    const store = new SqliteStore(database, resolvedPath);
    database.pragma("foreign_keys = ON");
    if (options.wal ?? true) {
      database.pragma("journal_mode = WAL");
    }
    database.pragma("busy_timeout = 5000");
    store.schemaVersion = migrateDatabase(store);
    return store;
  }

  schemaVersion = 0;

  exec(sql: string): void {
    this.database.exec(sql);
  }

  run(sql: string, parameters: unknown[] = []): Database.RunResult {
    return this.database.prepare(sql).run(...parameters as any[]);
  }

  get<T>(sql: string, parameters: unknown[] = []): T | undefined {
    return this.database.prepare(sql).get(...parameters as any[]) as T | undefined;
  }

  all<T>(sql: string, parameters: unknown[] = []): T[] {
    return this.database.prepare(sql).all(...parameters as any[]) as T[];
  }

  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  journalMode(): string {
    const pragma = this.database.pragma("journal_mode", { simple: true });
    return String(pragma).toLowerCase();
  }

  close(): void {
    this.database.close();
  }
}

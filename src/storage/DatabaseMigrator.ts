import type { SqliteStore } from "./SqliteStore.js";

interface Migration {
  version: number;
  apply(store: SqliteStore): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    apply(store) {
      store.exec(`
        CREATE TABLE IF NOT EXISTS boards (
          board_id TEXT PRIMARY KEY,
          probe_serial TEXT NOT NULL UNIQUE,
          device TEXT NOT NULL,
          ccxml_path TEXT NOT NULL,
          status TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          current_worker_instance_id TEXT,
          current_lease_id TEXT,
          last_heartbeat_at TEXT,
          last_seen_at TEXT,
          last_error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workers (
          worker_instance_id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          process_start_time TEXT NOT NULL,
          daemon_instance_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          last_heartbeat_at TEXT,
          current_command_id TEXT,
          owned_dss_processes_json TEXT NOT NULL,
          last_error_json TEXT,
          FOREIGN KEY(board_id) REFERENCES boards(board_id)
        );
        CREATE TABLE IF NOT EXISTS debug_sessions (
          session_id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          worker_instance_id TEXT,
          session_name TEXT NOT NULL,
          adapter_session_id TEXT,
          ccxml_path TEXT,
          core_map_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          last_snapshot_json TEXT,
          FOREIGN KEY(board_id) REFERENCES boards(board_id)
        );
        CREATE TABLE IF NOT EXISTS test_runs (
          job_id TEXT PRIMARY KEY,
          plan_name TEXT NOT NULL,
          plan_version INTEGER NOT NULL,
          plan_json TEXT NOT NULL,
          status TEXT NOT NULL,
          progress_current INTEGER NOT NULL,
          progress_total INTEGER NOT NULL,
          submitted_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          failure_policy TEXT NOT NULL,
          result_summary_json TEXT,
          error_json TEXT
        );
        CREATE TABLE IF NOT EXISTS test_run_boards (
          job_id TEXT NOT NULL,
          board_id TEXT NOT NULL,
          probe_serial TEXT NOT NULL,
          status TEXT NOT NULL,
          current_step_index INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          started_at TEXT,
          finished_at TEXT,
          error_json TEXT,
          PRIMARY KEY(job_id, board_id),
          FOREIGN KEY(job_id) REFERENCES test_runs(job_id),
          FOREIGN KEY(board_id) REFERENCES boards(board_id)
        );
        CREATE TABLE IF NOT EXISTS test_steps (
          step_run_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          board_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          step_type TEXT NOT NULL,
          input_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          idempotency_class TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          output_json TEXT,
          error_json TEXT,
          FOREIGN KEY(job_id) REFERENCES test_runs(job_id),
          FOREIGN KEY(board_id) REFERENCES boards(board_id)
        );
        CREATE TABLE IF NOT EXISTS board_leases (
          lease_id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL,
          probe_serial TEXT NOT NULL,
          owner_job_id TEXT,
          worker_instance_id TEXT,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          renewed_at TEXT NOT NULL,
          released_at TEXT,
          lease_token_hash TEXT NOT NULL,
          FOREIGN KEY(board_id) REFERENCES boards(board_id)
        );
        CREATE TABLE IF NOT EXISTS artifacts (
          artifact_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          board_id TEXT,
          artifact_type TEXT NOT NULL,
          path TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(job_id) REFERENCES test_runs(job_id)
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          level TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          job_id TEXT,
          board_id TEXT,
          worker_instance_id TEXT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_boards_status ON boards(status);
        CREATE INDEX IF NOT EXISTS idx_workers_board_status ON workers(board_id, status);
        CREATE INDEX IF NOT EXISTS idx_sessions_board_status ON debug_sessions(board_id, status);
        CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status, submitted_at);
        CREATE INDEX IF NOT EXISTS idx_test_steps_job_board ON test_steps(job_id, board_id, step_index);
        CREATE INDEX IF NOT EXISTS idx_active_leases_board ON board_leases(board_id, released_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_events_job_board ON events(job_id, board_id, timestamp);
      `);
    }
  },
  {
    version: 2,
    apply(store) {
      // A group is deliberately independent from a test run: it represents a
      // reusable physical wiring/topology declaration, while the test run is
      // the immutable execution record that references it in plan_json.
      store.exec(`
        CREATE TABLE IF NOT EXISTS board_groups (
          group_id TEXT PRIMARY KEY,
          group_type TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS board_group_members (
          group_id TEXT NOT NULL,
          board_id TEXT NOT NULL,
          member_role TEXT NOT NULL,
          member_index INTEGER NOT NULL,
          PRIMARY KEY(group_id, board_id),
          UNIQUE(group_id, member_index),
          FOREIGN KEY(group_id) REFERENCES board_groups(group_id) ON DELETE CASCADE,
          FOREIGN KEY(board_id) REFERENCES boards(board_id)
        );
        CREATE TABLE IF NOT EXISTS can_test_results (
          result_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          status TEXT NOT NULL,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(job_id) REFERENCES test_runs(job_id),
          FOREIGN KEY(group_id) REFERENCES board_groups(group_id)
        );
        CREATE INDEX IF NOT EXISTS idx_board_group_members_board ON board_group_members(board_id, group_id);
        CREATE INDEX IF NOT EXISTS idx_can_test_results_job ON can_test_results(job_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_can_test_results_group ON can_test_results(group_id, created_at);
      `);
    }
  }
];

export function migrateDatabase(store: SqliteStore): number {
  store.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  let currentVersion = Number(store.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version ?? 0);
  for (const migration of migrations.filter(candidate => candidate.version > currentVersion)) {
    store.transaction(() => {
      migration.apply(store);
      store.run("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)", [migration.version, new Date().toISOString()]);
    });
    currentVersion = migration.version;
  }
  return currentVersion;
}

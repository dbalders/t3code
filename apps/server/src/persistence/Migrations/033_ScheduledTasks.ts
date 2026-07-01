import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      target_thread_id TEXT,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL,
      model_selection_json TEXT,
      runtime_mode TEXT,
      interaction_mode TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      catch_up INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id),
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      result_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, scheduled_for)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks(status, next_run_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project
    ON scheduled_tasks(project_id, status, next_run_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
    ON scheduled_task_runs(task_id, scheduled_for DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status
    ON scheduled_task_runs(status, scheduled_for)
  `;
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("027_028_ProviderInstanceIdColumns", (it) => {
  it.effect("continues when provider_session_runtime was partially migrated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 26 });
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-legacy',
          'running',
          'codex',
          'provider-session-legacy',
          'provider-thread-legacy',
          'approval-required',
          'turn-legacy',
          NULL,
          '2026-06-01T00:00:00.000Z'
        ),
        (
          'thread-invalid-legacy',
          'running',
          'OpenAI/Codex',
          'provider-session-invalid-legacy',
          'provider-thread-invalid-legacy',
          'approval-required',
          'turn-invalid-legacy',
          NULL,
          '2026-06-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        ALTER TABLE provider_session_runtime
        ADD COLUMN provider_instance_id TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 28 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (27, 28)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 27,
          name: "ProviderSessionRuntimeInstanceId",
        },
        {
          migration_id: 28,
          name: "ProjectionThreadSessionInstanceId",
        },
      ]);

      const providerSessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      assert.ok(providerSessionColumns.some((column) => column.name === "provider_instance_id"));

      const projectionThreadSessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(
        projectionThreadSessionColumns.some((column) => column.name === "provider_instance_id"),
      );

      const providerSessionIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(provider_session_runtime)
      `;
      assert.ok(
        providerSessionIndexes.some(
          (index) => index.name === "idx_provider_session_runtime_instance",
        ),
      );

      const projectionThreadSessionIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_sessions)
      `;
      assert.ok(
        projectionThreadSessionIndexes.some(
          (index) => index.name === "idx_projection_thread_sessions_instance",
        ),
      );

      const projectedSessions = yield* sql<{
        readonly thread_id: string;
        readonly provider_instance_id: string | null;
      }>`
        SELECT thread_id, provider_instance_id
        FROM projection_thread_sessions
        WHERE thread_id IN ('thread-invalid-legacy', 'thread-legacy')
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(projectedSessions, [
        {
          thread_id: "thread-invalid-legacy",
          provider_instance_id: null,
        },
        {
          thread_id: "thread-legacy",
          provider_instance_id: "codex",
        },
      ]);
    }),
  );
});

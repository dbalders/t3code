import { IsoDateTime, ServerAgentSettings } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ServerAgentSettingsRepositoryError,
} from "../Errors.ts";
import {
  ServerAgentSettingsRepository,
  type ServerAgentSettingsRepositoryShape,
} from "../Services/ServerAgentSettings.ts";

const GLOBAL_SCOPE = "global";

const ServerAgentSettingsDbRowSchema = Schema.Struct({
  scope: Schema.String,
  settingsJson: Schema.String,
  updatedAt: IsoDateTime,
});

const GetGlobalServerAgentSettingsRequest = Schema.Struct({
  scope: Schema.String,
});

const UpsertServerAgentSettingsDbRequest = Schema.Struct({
  scope: Schema.String,
  settingsJson: Schema.String,
  updatedAt: IsoDateTime,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ServerAgentSettingsRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeServerAgentSettingsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeServerAgentSettingsJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(ServerAgentSettings),
  );
  const encodeServerAgentSettingsJson = Schema.encodeEffect(
    Schema.fromJsonString(ServerAgentSettings),
  );

  const getGlobalSettingsRow = SqlSchema.findOneOption({
    Request: GetGlobalServerAgentSettingsRequest,
    Result: ServerAgentSettingsDbRowSchema,
    execute: ({ scope }) =>
      sql`
        SELECT
          scope,
          settings_json AS "settingsJson",
          updated_at AS "updatedAt"
        FROM server_agent_settings
        WHERE scope = ${scope}
      `,
  });

  const upsertGlobalSettingsRow = SqlSchema.void({
    Request: UpsertServerAgentSettingsDbRequest,
    execute: (input) =>
      sql`
        INSERT INTO server_agent_settings (
          scope,
          settings_json,
          updated_at
        )
        VALUES (
          ${input.scope},
          ${input.settingsJson},
          ${input.updatedAt}
        )
        ON CONFLICT (scope)
        DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `,
  });

  const getGlobal: ServerAgentSettingsRepositoryShape["getGlobal"] = () =>
    getGlobalSettingsRow({ scope: GLOBAL_SCOPE }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ServerAgentSettingsRepository.getGlobal:query",
          "ServerAgentSettingsRepository.getGlobal:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeServerAgentSettingsJson(row.settingsJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ServerAgentSettingsRepository.getGlobal:rowToSettings"),
              ),
              Effect.map((settings) => Option.some(settings)),
            ),
        }),
      ),
    );

  const upsertGlobal: ServerAgentSettingsRepositoryShape["upsertGlobal"] = (input) =>
    encodeServerAgentSettingsJson(input.settings).pipe(
      Effect.mapError(
        toPersistenceDecodeError("ServerAgentSettingsRepository.upsertGlobal:encodeSettings"),
      ),
      Effect.flatMap((settingsJson) =>
        upsertGlobalSettingsRow({
          scope: GLOBAL_SCOPE,
          settingsJson,
          updatedAt: input.updatedAt,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ServerAgentSettingsRepository.upsertGlobal:query",
              "ServerAgentSettingsRepository.upsertGlobal:encodeRequest",
            ),
          ),
        ),
      ),
    );

  return {
    getGlobal,
    upsertGlobal,
  } satisfies ServerAgentSettingsRepositoryShape;
});

export const ServerAgentSettingsRepositoryLive = Layer.effect(
  ServerAgentSettingsRepository,
  makeServerAgentSettingsRepository,
);

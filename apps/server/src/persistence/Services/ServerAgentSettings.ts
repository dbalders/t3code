/**
 * ServerAgentSettingsRepository - Repository interface for global server agent settings.
 *
 * Owns persistence operations for server-authoritative agent settings.
 *
 * @module ServerAgentSettingsRepository
 */
import { IsoDateTime, ServerAgentSettings } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ServerAgentSettingsRepositoryError } from "../Errors.ts";

export const UpsertServerAgentSettingsInput = Schema.Struct({
  settings: ServerAgentSettings,
  updatedAt: IsoDateTime,
});
export type UpsertServerAgentSettingsInput = typeof UpsertServerAgentSettingsInput.Type;

/**
 * ServerAgentSettingsRepositoryShape - Service API for persisted global settings.
 */
export interface ServerAgentSettingsRepositoryShape {
  /**
   * Read the persisted global agent settings row.
   */
  readonly getGlobal: () => Effect.Effect<
    Option.Option<ServerAgentSettings>,
    ServerAgentSettingsRepositoryError
  >;

  /**
   * Upsert the global agent settings row.
   */
  readonly upsertGlobal: (
    input: UpsertServerAgentSettingsInput,
  ) => Effect.Effect<void, ServerAgentSettingsRepositoryError>;
}

/**
 * ServerAgentSettingsRepository - Service tag for global agent settings persistence.
 */
export class ServerAgentSettingsRepository extends ServiceMap.Service<
  ServerAgentSettingsRepository,
  ServerAgentSettingsRepositoryShape
>()("t3/persistence/Services/ServerAgentSettings/ServerAgentSettingsRepository") {}

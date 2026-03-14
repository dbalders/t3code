/**
 * ServerAgentSettingsService - Server-authoritative agent settings service interface.
 *
 * Provides read/patch operations over globally persisted agent settings and
 * emits updates for websocket fanout.
 *
 * @module ServerAgentSettingsService
 */
import {
  type ServerAgentSettings,
  type ServerAgentSettingsState,
  type ServerPatchAgentSettingsInput,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ServerAgentSettingsRepositoryError } from "../../persistence/Errors.ts";

export type ServerAgentSettingsServiceError = ServerAgentSettingsRepositoryError;

/**
 * ServerAgentSettingsServiceShape - Service API for global server agent settings.
 */
export interface ServerAgentSettingsServiceShape {
  /**
   * Read current settings and whether they were explicitly initialized.
   */
  readonly getState: Effect.Effect<ServerAgentSettingsState, ServerAgentSettingsServiceError>;

  /**
   * Patch and persist the global settings.
   */
  readonly patch: (
    input: ServerPatchAgentSettingsInput,
  ) => Effect.Effect<ServerAgentSettings, ServerAgentSettingsServiceError>;

  /**
   * Stream of normalized settings updates.
   */
  readonly streamChanges: Stream.Stream<ServerAgentSettings>;
}

/**
 * ServerAgentSettingsService - Service tag for server settings operations.
 */
export class ServerAgentSettingsService extends ServiceMap.Service<
  ServerAgentSettingsService,
  ServerAgentSettingsServiceShape
>()("t3/serverSettings/Services/ServerAgentSettings/ServerAgentSettingsService") {}

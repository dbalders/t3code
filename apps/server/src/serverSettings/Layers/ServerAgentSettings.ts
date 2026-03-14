import {
  ServerAgentSettings,
  type ServerAgentSettings as ServerAgentSettingsValue,
  type ServerPatchAgentSettingsInput,
} from "@t3tools/contracts";
import { normalizeCustomModelSlugs } from "@t3tools/shared/model";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { ServerAgentSettingsRepository } from "../../persistence/Services/ServerAgentSettings.ts";
import {
  ServerAgentSettingsService,
  type ServerAgentSettingsServiceShape,
} from "../Services/ServerAgentSettings.ts";

const DEFAULT_SERVER_AGENT_SETTINGS = ServerAgentSettings.makeUnsafe({});

function normalizeServerAgentSettings(
  settings: ServerAgentSettingsValue,
): ServerAgentSettingsValue {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
  };
}

function applyServerAgentSettingsPatch(
  current: ServerAgentSettingsValue,
  patch: ServerPatchAgentSettingsInput,
): ServerAgentSettingsValue {
  return normalizeServerAgentSettings({
    codexBinaryPath:
      patch.codexBinaryPath !== undefined ? patch.codexBinaryPath : current.codexBinaryPath,
    codexHomePath: patch.codexHomePath !== undefined ? patch.codexHomePath : current.codexHomePath,
    defaultThreadEnvMode:
      patch.defaultThreadEnvMode !== undefined
        ? patch.defaultThreadEnvMode
        : current.defaultThreadEnvMode,
    customCodexModels:
      patch.customCodexModels !== undefined ? patch.customCodexModels : current.customCodexModels,
  });
}

const makeServerAgentSettingsService = Effect.gen(function* () {
  const repository = yield* ServerAgentSettingsRepository;
  const changesPubSub = yield* PubSub.unbounded<ServerAgentSettingsValue>();

  const getState: ServerAgentSettingsServiceShape["getState"] = repository.getGlobal().pipe(
    Effect.map((settingsOption) =>
      Option.match(settingsOption, {
        onNone: () => ({
          settings: DEFAULT_SERVER_AGENT_SETTINGS,
          isInitialized: false,
        }),
        onSome: (persistedSettings) => ({
          settings: normalizeServerAgentSettings(persistedSettings),
          isInitialized: true,
        }),
      }),
    ),
  );

  const patch: ServerAgentSettingsServiceShape["patch"] = Effect.fn(function* (input) {
    const currentState = yield* getState;
    const nextSettings = applyServerAgentSettingsPatch(currentState.settings, input);
    const updatedAt = new Date().toISOString();
    yield* repository.upsertGlobal({
      settings: nextSettings,
      updatedAt,
    });
    yield* PubSub.publish(changesPubSub, nextSettings).pipe(Effect.asVoid);
    return nextSettings;
  });

  return {
    getState,
    patch,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerAgentSettingsServiceShape;
});

export const ServerAgentSettingsServiceLive = Layer.effect(
  ServerAgentSettingsService,
  makeServerAgentSettingsService,
);

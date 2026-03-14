import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { assertNone, assertSome } from "@effect/vitest/utils";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ServerAgentSettingsRepositoryLive } from "./ServerAgentSettings.ts";
import { ServerAgentSettingsRepository } from "../Services/ServerAgentSettings.ts";

const repositoryLayer = ServerAgentSettingsRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const layer = it.layer(Layer.mergeAll(repositoryLayer, NodeServices.layer));

layer("ServerAgentSettingsRepositoryLive", (it) => {
  it.effect("returns none when global settings are uninitialized", () =>
    Effect.gen(function* () {
      const repository = yield* ServerAgentSettingsRepository;
      const settings = yield* repository.getGlobal();
      assertNone(settings);
    }),
  );

  it.effect("upserts and reads global settings", () =>
    Effect.gen(function* () {
      const repository = yield* ServerAgentSettingsRepository;

      yield* repository.upsertGlobal({
        settings: {
          codexBinaryPath: "/usr/local/bin/codex",
          codexHomePath: "/tmp/.codex",
          defaultThreadEnvMode: "worktree",
          customCodexModels: ["custom/model-a"],
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const settings = yield* repository.getGlobal();
      assertSome(settings, {
        codexBinaryPath: "/usr/local/bin/codex",
        codexHomePath: "/tmp/.codex",
        defaultThreadEnvMode: "worktree",
        customCodexModels: ["custom/model-a"],
      });
      if (Option.isSome(settings)) {
        assert.deepEqual(settings.value.customCodexModels, ["custom/model-a"]);
      }
    }),
  );
});

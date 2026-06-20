import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import {
  removeProviderSkillFolder,
  resolveProviderSkillRemovalTarget,
} from "./removeProviderSkill.ts";

const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const TestOpenCodeConfigJson = fromJsonStringPretty(
  Schema.Struct({
    skills: Schema.Struct({
      paths: Schema.Array(Schema.String),
    }),
  }),
);
const MalformedOpenCodeConfigJson = fromJsonStringPretty(
  Schema.Struct({
    skills: Schema.Struct({
      paths: Schema.String,
    }),
  }),
);
const encodeTestOpenCodeConfig = Schema.encodeSync(TestOpenCodeConfigJson);
const decodeTestOpenCodeConfig = Schema.decodeUnknownSync(TestOpenCodeConfigJson);
const encodeMalformedOpenCodeConfig = Schema.encodeSync(MalformedOpenCodeConfigJson);

function makeSkill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, "name">) {
  return {
    path: `/Users/test/.agents/skills/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill;
}

function makeProvider(skills: ReadonlyArray<ServerProviderSkill>): ServerProvider {
  return {
    instanceId: OPENCODE_INSTANCE_ID,
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-18T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [...skills],
  };
}

it.layer(NodeServices.layer)("resolveProviderSkillRemovalTarget", (it) => {
  it.effect("resolves the containing skill folder for an inventory-backed skill", () =>
    Effect.gen(function* () {
      const skill = makeSkill({ name: "release" });
      const target = yield* resolveProviderSkillRemovalTarget({
        providers: [makeProvider([skill])],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          skillPath: skill.path,
        },
      });

      expect(target).toEqual({
        skillDirectoryPath: "/Users/test/.agents/skills/release",
      });
    }),
  );

  it.effect("rejects paths that are not in the provider inventory", () =>
    Effect.gen(function* () {
      const target = yield* Effect.flip(
        resolveProviderSkillRemovalTarget({
          providers: [makeProvider([makeSkill({ name: "release" })])],
          request: {
            instanceId: OPENCODE_INSTANCE_ID,
            skillPath: "/Users/test/.agents/skills/other/SKILL.md",
          },
        }),
      );

      expect(target).toMatchObject({
        _tag: "ServerProviderSkillRemovalError",
        message: "Skill was not found in the current provider inventory.",
      });
    }),
  );

  it.effect("rejects inventory paths that are not SKILL.md files", () =>
    Effect.gen(function* () {
      const target = yield* Effect.flip(
        resolveProviderSkillRemovalTarget({
          providers: [
            makeProvider([
              makeSkill({
                name: "release",
                path: "/Users/test/.agents/skills/release/README.md",
              }),
            ]),
          ],
          request: {
            instanceId: OPENCODE_INSTANCE_ID,
            skillPath: "/Users/test/.agents/skills/release/README.md",
          },
        }),
      );

      expect(target).toMatchObject({
        _tag: "ServerProviderSkillRemovalError",
        message: "Only SKILL.md-backed skill folders can be removed.",
      });
    }),
  );

  it.effect("rejects SKILL.md paths outside a skills directory", () =>
    Effect.gen(function* () {
      const target = yield* Effect.flip(
        resolveProviderSkillRemovalTarget({
          providers: [
            makeProvider([
              makeSkill({
                name: "release",
                path: "/Users/test/release/SKILL.md",
              }),
            ]),
          ],
          request: {
            instanceId: OPENCODE_INSTANCE_ID,
            skillPath: "/Users/test/release/SKILL.md",
          },
        }),
      );

      expect(target).toMatchObject({
        _tag: "ServerProviderSkillRemovalError",
        message: "Skill folder must live directly under a skills directory.",
      });
    }),
  );

  it.effect("removes the containing skill folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-remove-provider-skill-",
      });
      const skillDirectoryPath = path.join(root, "skills", "release");
      yield* fileSystem.makeDirectory(skillDirectoryPath, { recursive: true });
      yield* fileSystem.writeFileString(path.join(skillDirectoryPath, "SKILL.md"), "name: release");

      yield* removeProviderSkillFolder({ skillDirectoryPath });

      expect(yield* fileSystem.exists(skillDirectoryPath)).toBe(false);
    }),
  );

  it.effect("unregisters removed UCSD skills from the OpenCode config paths list", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-remove-provider-skill-ucsd-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const keepDirectoryPath = path.join(ucsdRoot, "skills", "keep");
      const removeDirectoryPath = path.join(ucsdRoot, "skills", "remove");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fileSystem.makeDirectory(keepDirectoryPath, { recursive: true });
      yield* fileSystem.makeDirectory(removeDirectoryPath, { recursive: true });
      yield* fileSystem.writeFileString(path.join(removeDirectoryPath, "SKILL.md"), "name: remove");
      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(
        configPath,
        encodeTestOpenCodeConfig({
          skills: { paths: [keepDirectoryPath, removeDirectoryPath] },
        }),
      );

      yield* removeProviderSkillFolder({ skillDirectoryPath: removeDirectoryPath });

      const config = decodeTestOpenCodeConfig(yield* fileSystem.readFileString(configPath));
      expect(yield* fileSystem.exists(removeDirectoryPath)).toBe(false);
      expect(config.skills.paths).toEqual([keepDirectoryPath]);
    }),
  );

  it.effect("keeps UCSD skill files when OpenCode config unregister fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-remove-provider-skill-ucsd-fail-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const removeDirectoryPath = path.join(ucsdRoot, "skills", "remove");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fileSystem.makeDirectory(removeDirectoryPath, { recursive: true });
      yield* fileSystem.writeFileString(path.join(removeDirectoryPath, "SKILL.md"), "name: remove");
      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(
        configPath,
        encodeMalformedOpenCodeConfig({ skills: { paths: "bad" } }),
      );

      const error = yield* removeProviderSkillFolder({
        skillDirectoryPath: removeDirectoryPath,
      }).pipe(Effect.flip);

      expect(error.message).toContain("Failed to unregister skill folder");
      expect(yield* fileSystem.exists(removeDirectoryPath)).toBe(true);
    }),
  );

  it.effect("restores the OpenCode config path when folder deletion fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-remove-provider-skill-ucsd-rollback-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const removeDirectoryPath = path.join(ucsdRoot, "skills", "missing");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(
        configPath,
        encodeTestOpenCodeConfig({ skills: { paths: [removeDirectoryPath] } }),
      );

      const error = yield* removeProviderSkillFolder({
        skillDirectoryPath: removeDirectoryPath,
      }).pipe(Effect.flip);

      const config = decodeTestOpenCodeConfig(yield* fileSystem.readFileString(configPath));
      expect(error.message).toContain("Failed to remove skill folder");
      expect(config.skills.paths).toEqual([removeDirectoryPath]);
    }),
  );
});

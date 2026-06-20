import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderSkillBundle,
  ServerProviderSkillCatalog,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { installProviderSkill, mergeInstalledProviderSkill } from "./installProviderSkill.ts";

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
const encodeTestSkillCatalog = Schema.encodeSync(fromJsonStringPretty(ServerProviderSkillCatalog));
const encodeTestSkillBundle = Schema.encodeSync(fromJsonStringPretty(ServerProviderSkillBundle));

const unusedGitLayer = Layer.mock(VcsProcess.VcsProcess)({
  run: () => Effect.die("Git should not be used in this installer test"),
});

function makeHttpLayer(response: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
    ),
  );
}

function vcsOutput(stdout = ""): VcsProcess.VcsProcessOutput {
  return {
    exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeProviderWithSkills(skills: ReadonlyArray<ServerProviderSkill>): ServerProvider {
  return {
    instanceId: OPENCODE_INSTANCE_ID,
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-19T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills,
  };
}

function makeProvider(skill: ServerProviderSkill): ServerProvider {
  return makeProviderWithSkills([skill]);
}

function installTestSkillRoot() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-install-provider-skill-" });
    const seedDirectory = path.join(root, "skills", "existing-skill");
    const seedPath = path.join(seedDirectory, "SKILL.md");

    yield* fs.makeDirectory(seedDirectory, { recursive: true });
    yield* fs.writeFileString(
      seedPath,
      "---\nname: existing-skill\ndescription: Existing skill\n---\n",
    );

    return {
      root,
      provider: makeProvider({
        name: "existing-skill",
        path: seedPath,
        enabled: true,
        scope: "user",
      }),
    };
  });
}

it.layer(NodeServices.layer)("installProviderSkill", (it) => {
  it.effect("installs a bundled catalog fallback into the provider skill root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, provider } = yield* installTestSkillRoot();

      const installed = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "catalog",
            catalogEntryId: "tritonai-feedback",
          },
        },
        environment: {
          T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("missing", { status: 500 })),
            unusedGitLayer,
          ),
        ),
      );

      const expectedPath = path.join(root, "skills", "tritonai-feedback", "SKILL.md");
      assert.equal(installed.skillName, "tritonai-feedback");
      assert.equal(installed.skillPath, expectedPath);
      assert.equal(yield* fs.exists(expectedPath), true);
    }),
  );

  it.effect(
    "refreshes an existing matching catalog skill folder that the provider did not report",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, provider } = yield* installTestSkillRoot();
        const existingDirectory = path.join(root, "skills", "tritonai-feedback");
        const existingPath = path.join(existingDirectory, "SKILL.md");
        const existingContent =
          "---\nname: tritonai-feedback\ndescription: Existing catalog skill\n---\n\nAlready here.";

        yield* fs.makeDirectory(existingDirectory, { recursive: true });
        yield* fs.writeFileString(existingPath, existingContent);

        const installed = yield* installProviderSkill({
          providers: [provider],
          request: {
            instanceId: OPENCODE_INSTANCE_ID,
            source: {
              type: "catalog",
              catalogEntryId: "tritonai-feedback",
            },
          },
          environment: {
            T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              makeHttpLayer(() => new Response("missing", { status: 500 })),
              unusedGitLayer,
            ),
          ),
        );

        assert.equal(installed.skillName, "tritonai-feedback");
        assert.equal(installed.skillPath, existingPath);
        assert.notEqual(yield* fs.readFileString(existingPath), existingContent);
        assert.match(yield* fs.readFileString(existingPath), /# TritonAI Feedback/u);
      }),
  );

  it.effect("refreshes an existing linked skill folder with fetched bundle files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, provider } = yield* installTestSkillRoot();
      const existingDirectory = path.join(root, "skills", "linked-skill");
      const existingPath = path.join(existingDirectory, "SKILL.md");
      const freshSkill = "---\nname: linked-skill\ndescription: Fresh linked skill\n---\n\nFresh.";
      const bundle = encodeTestSkillBundle({
        version: 1,
        skillId: "linked-skill",
        files: [
          {
            path: "SKILL.md",
            content: freshSkill,
          },
          {
            path: "references/guide.md",
            content: "fresh guide",
          },
        ],
      });

      yield* fs.makeDirectory(existingDirectory, { recursive: true });
      yield* fs.writeFileString(
        existingPath,
        "---\nname: linked-skill\ndescription: Stale linked skill\n---\n\nStale.",
      );

      const installed = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "https://skills.test/linked-skill.json",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(
              () => new Response(bundle, { headers: { "content-type": "application/json" } }),
            ),
            unusedGitLayer,
          ),
        ),
      );

      assert.equal(installed.skillName, "linked-skill");
      assert.equal(installed.skillPath, existingPath);
      assert.equal(yield* fs.readFileString(existingPath), freshSkill);
      assert.equal(
        yield* fs.readFileString(path.join(existingDirectory, "references", "guide.md")),
        "fresh guide",
      );
    }),
  );

  it.effect("registers refreshed UCSD catalog skill folders in OpenCode config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-install-provider-skill-adopt-ucsd-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const existingDirectory = path.join(ucsdRoot, "skills", "existing-skill");
      const adoptedDirectory = path.join(ucsdRoot, "skills", "tritonai-feedback");
      const adoptedPath = path.join(adoptedDirectory, "SKILL.md");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fs.makeDirectory(existingDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(existingDirectory, "SKILL.md"),
        "---\nname: existing-skill\ndescription: Existing skill\n---\n",
      );
      yield* fs.makeDirectory(adoptedDirectory, { recursive: true });
      yield* fs.writeFileString(
        adoptedPath,
        "---\nname: tritonai-feedback\ndescription: Existing catalog skill\n---\n\nAlready here.",
      );
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fs.writeFileString(
        configPath,
        encodeTestOpenCodeConfig({ skills: { paths: [existingDirectory] } }),
      );

      const installed = yield* installProviderSkill({
        providers: [
          makeProvider({
            name: "existing-skill",
            path: path.join(existingDirectory, "SKILL.md"),
            enabled: true,
            scope: "user",
          }),
        ],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "catalog",
            catalogEntryId: "tritonai-feedback",
          },
        },
        environment: {
          OPENCODE_CONFIG: configPath,
          T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("missing", { status: 500 })),
            unusedGitLayer,
          ),
        ),
      );

      const config = decodeTestOpenCodeConfig(yield* fs.readFileString(configPath));
      assert.equal(installed.skillPath, adoptedPath);
      assert.deepStrictEqual(config.skills.paths, [existingDirectory, adoptedDirectory]);
    }),
  );

  it.effect("installs catalog skills into the UCSD config root when no skills are reported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-install-provider-skill-empty-provider-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fs.writeFileString(configPath, encodeTestOpenCodeConfig({ skills: { paths: [] } }));

      const installed = yield* installProviderSkill({
        providers: [makeProviderWithSkills([])],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "catalog",
            catalogEntryId: "tritonai-feedback",
          },
        },
        environment: {
          HOME: root,
          OPENCODE_CONFIG: configPath,
          T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("missing", { status: 500 })),
            unusedGitLayer,
          ),
        ),
      );

      const expectedDirectory = path.join(ucsdRoot, "skills", "tritonai-feedback");
      const expectedPath = path.join(expectedDirectory, "SKILL.md");
      const config = decodeTestOpenCodeConfig(yield* fs.readFileString(configPath));

      assert.equal(installed.skillName, "tritonai-feedback");
      assert.equal(installed.skillPath, expectedPath);
      assert.equal(yield* fs.exists(expectedPath), true);
      assert.deepStrictEqual(config.skills.paths, [expectedDirectory]);
    }),
  );

  it.effect("does not fall back to HOME when OPENCODE_CONFIG is not UCSD-shaped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-install-provider-skill-invalid-config-",
      });
      const homeUcsdRoot = path.join(root, ".agents", "ucsd");
      const homeConfigPath = path.join(homeUcsdRoot, "config", "opencode", "opencode.json");
      const invalidConfigPath = path.join(root, "not-ucsd", "opencode.json");

      yield* fs.makeDirectory(path.dirname(homeConfigPath), { recursive: true });
      yield* fs.writeFileString(
        homeConfigPath,
        encodeTestOpenCodeConfig({ skills: { paths: [] } }),
      );

      const error = yield* installProviderSkill({
        providers: [makeProviderWithSkills([])],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "catalog",
            catalogEntryId: "tritonai-feedback",
          },
        },
        environment: {
          HOME: root,
          OPENCODE_CONFIG: invalidConfigPath,
          T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("missing", { status: 500 })),
            unusedGitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /OPENCODE_CONFIG must point to a UCSD OpenCode config/iu);
      assert.equal(yield* fs.exists(path.join(homeUcsdRoot, "skills", "tritonai-feedback")), false);
    }),
  );

  it.effect("rejects an existing skill folder with a different frontmatter name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, provider } = yield* installTestSkillRoot();
      const existingDirectory = path.join(root, "skills", "tritonai-feedback");

      yield* fs.makeDirectory(existingDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(existingDirectory, "SKILL.md"),
        "---\nname: other-skill\ndescription: Wrong skill\n---\n",
      );

      const error = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "catalog",
            catalogEntryId: "tritonai-feedback",
          },
        },
        environment: {
          T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("missing", { status: 500 })),
            unusedGitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /already contains skill 'other-skill'/iu);
    }),
  );

  it.effect("rejects a catalog bundle that does not match the selected entry", () =>
    Effect.gen(function* () {
      const { provider } = yield* installTestSkillRoot();
      const catalog = encodeTestSkillCatalog({
        version: 1,
        generatedAt: "2026-06-19T00:00:00.000Z",
        sourceStatus: "remote",
        entries: [
          {
            id: "expected-skill",
            name: "expected-skill",
            title: "Expected Skill",
            description: "Expected catalog skill",
            category: "Test",
            tier: "experimental",
            section: "community",
            owner: "AI Tools",
            updated: "2026-06-19",
            sourceKind: "cloudflare",
            sourceUrl: "https://skills.test/wrong/SKILL.md",
          },
        ],
      });

      const error = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "catalog",
            catalogEntryId: "expected-skill",
          },
        },
        environment: {
          T3CODE_SKILL_CATALOG_URL: "https://skills.test/catalog.json",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer((request) => {
              if (request.url.toString() === "https://skills.test/catalog.json") {
                return new Response(catalog, { headers: { "content-type": "application/json" } });
              }
              return new Response("---\nname: wrong-skill\ndescription: Wrong skill\n---\n", {
                headers: { "content-type": "text/markdown" },
              });
            }),
            unusedGitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /does not match/iu);
    }),
  );

  it.effect("installs a fetched SKILL.md from a direct link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, provider } = yield* installTestSkillRoot();

      const installed = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "https://skills.test/custom/SKILL.md",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer((request) => {
              assert.equal(request.url.toString(), "https://skills.test/custom/SKILL.md");
              return new Response(
                "---\nname: linked-skill\ndescription: Linked test skill\n---\n\nUse this skill.",
                {
                  headers: { "content-type": "text/markdown" },
                },
              );
            }),
            unusedGitLayer,
          ),
        ),
      );

      const expectedPath = path.join(root, "skills", "linked-skill", "SKILL.md");
      assert.equal(installed.skillName, "linked-skill");
      assert.equal(installed.skillPath, expectedPath);
      assert.equal(
        yield* fs.readFileString(expectedPath),
        "---\nname: linked-skill\ndescription: Linked test skill\n---\n\nUse this skill.",
      );
    }),
  );

  it.effect("allows loopback cleartext skill links for local development", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, provider } = yield* installTestSkillRoot();

      const installed = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "http://127.0.0.1/custom/SKILL.md",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer((request) => {
              assert.equal(request.url.toString(), "http://127.0.0.1/custom/SKILL.md");
              return new Response(
                "---\nname: local-linked-skill\ndescription: Local linked test skill\n---\n\nUse this skill.",
                {
                  headers: { "content-type": "text/markdown" },
                },
              );
            }),
            unusedGitLayer,
          ),
        ),
      );

      const expectedPath = path.join(root, "skills", "local-linked-skill", "SKILL.md");
      assert.equal(installed.skillName, "local-linked-skill");
      assert.equal(installed.skillPath, expectedPath);
      assert.equal(yield* fs.exists(expectedPath), true);
    }),
  );

  it.effect("rejects non-loopback cleartext skill links", () =>
    Effect.gen(function* () {
      const { provider } = yield* installTestSkillRoot();

      const error = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "http://skills.test/custom/SKILL.md",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("unexpected")),
            unusedGitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /HTTPS/iu);
    }),
  );

  it.effect("rejects oversized direct link responses before installing", () =>
    Effect.gen(function* () {
      const { provider } = yield* installTestSkillRoot();

      const error = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "https://skills.test/huge/SKILL.md",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(
              () =>
                new Response("---\nname: huge-skill\n---\n", {
                  headers: {
                    "content-length": String(4 * 1024 * 1024),
                    "content-type": "text/markdown",
                  },
                }),
            ),
            unusedGitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /exceeds/iu);
    }),
  );

  it.effect(
    "installs GitHub skills from slash-delimited branch links without bundling symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, provider } = yield* installTestSkillRoot();
        const gitLayer = Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              if (input.args[0] === "ls-remote") {
                assert.deepStrictEqual(input.args, [
                  "ls-remote",
                  "--heads",
                  "--tags",
                  "https://github.com/tritonai/skills.git",
                ]);
                return vcsOutput(
                  [
                    "1111111111111111111111111111111111111111\trefs/heads/main",
                    "2222222222222222222222222222222222222222\trefs/heads/feature/skills-marketplace",
                  ].join("\n"),
                );
              }

              if (input.args[0] === "clone") {
                assert.deepStrictEqual(input.args.slice(0, 5), [
                  "clone",
                  "--depth",
                  "1",
                  "--branch",
                  "feature/skills-marketplace",
                ]);
                const destination = input.args.at(-1);
                if (!destination) {
                  throw new Error("Missing clone destination.");
                }
                const skillDirectory = path.join(destination, "skills", "github-linked-skill");
                const externalFile = path.join(input.cwd, "external.md");
                yield* fs.makeDirectory(skillDirectory, { recursive: true });
                yield* fs.writeFileString(externalFile, "external content");
                yield* fs.writeFileString(
                  path.join(skillDirectory, "SKILL.md"),
                  "---\nname: github-linked-skill\ndescription: GitHub linked test skill\n---\n",
                );
                yield* fs.symlink(externalFile, path.join(skillDirectory, "external-link.md"));
                return vcsOutput();
              }

              throw new Error(`Unexpected git command: ${input.args.join(" ")}`);
            }).pipe(Effect.orDie),
        });

        const installed = yield* installProviderSkill({
          providers: [provider],
          request: {
            instanceId: OPENCODE_INSTANCE_ID,
            source: {
              type: "url",
              url: "https://github.com/tritonai/skills/tree/feature/skills-marketplace/skills/github-linked-skill",
            },
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              makeHttpLayer(() => new Response("unexpected")),
              gitLayer,
            ),
          ),
        );

        const expectedPath = path.join(root, "skills", "github-linked-skill", "SKILL.md");
        assert.equal(installed.skillName, "github-linked-skill");
        assert.equal(installed.skillPath, expectedPath);
        assert.equal(yield* fs.exists(expectedPath), true);
        assert.equal(
          yield* fs.exists(path.join(root, "skills", "github-linked-skill", "external-link.md")),
          false,
        );
      }),
  );

  it.effect("rejects oversized GitHub skill files before installing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, provider } = yield* installTestSkillRoot();
      const gitLayer = Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.gen(function* () {
            if (input.args[0] === "ls-remote") {
              return vcsOutput("1111111111111111111111111111111111111111\trefs/heads/main");
            }
            if (input.args[0] === "clone") {
              const destination = input.args.at(-1);
              if (!destination) {
                throw new Error("Missing clone destination.");
              }
              const skillDirectory = path.join(destination, "skills", "huge-skill");
              yield* fs.makeDirectory(skillDirectory, { recursive: true });
              yield* fs.writeFileString(
                path.join(skillDirectory, "SKILL.md"),
                "---\nname: huge-skill\ndescription: Huge test skill\n---\n",
              );
              yield* fs.writeFileString(
                path.join(skillDirectory, "large.txt"),
                "x".repeat(2 * 1024 * 1024 + 1),
              );
              return vcsOutput();
            }
            throw new Error(`Unexpected git command: ${input.args.join(" ")}`);
          }).pipe(Effect.orDie),
      });

      const error = yield* installProviderSkill({
        providers: [provider],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "https://github.com/tritonai/skills/tree/main/skills/huge-skill",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(() => new Response("unexpected")),
            gitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /too large/iu);
      assert.equal(yield* fs.exists(path.join(root, "skills", "huge-skill")), false);
    }),
  );

  it.effect("rolls back installed files when OpenCode config registration fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-install-provider-skill-rollback-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const existingDirectory = path.join(ucsdRoot, "skills", "existing-skill");
      const existingPath = path.join(existingDirectory, "SKILL.md");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fs.makeDirectory(existingDirectory, { recursive: true });
      yield* fs.writeFileString(
        existingPath,
        "---\nname: existing-skill\ndescription: Existing skill\n---\n",
      );
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fs.writeFileString(
        configPath,
        encodeMalformedOpenCodeConfig({ skills: { paths: "bad" } }),
      );

      const error = yield* installProviderSkill({
        providers: [
          makeProvider({
            name: "existing-skill",
            path: existingPath,
            enabled: true,
            scope: "user",
          }),
        ],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "https://skills.test/custom/SKILL.md",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(
              () =>
                new Response(
                  "---\nname: linked-skill\ndescription: Linked test skill\n---\n\nUse this skill.",
                  { headers: { "content-type": "text/markdown" } },
                ),
            ),
            unusedGitLayer,
          ),
        ),
        Effect.flip,
      );

      assert.match(error.message, /OpenCode skill config/iu);
      assert.equal(yield* fs.exists(path.join(ucsdRoot, "skills", "linked-skill")), false);
    }),
  );

  it.effect("registers linked UCSD skills in the OpenCode config paths list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3code-install-provider-skill-ucsd-",
      });
      const ucsdRoot = path.join(root, ".agents", "ucsd");
      const existingDirectory = path.join(ucsdRoot, "skills", "existing-skill");
      const existingPath = path.join(existingDirectory, "SKILL.md");
      const configPath = path.join(ucsdRoot, "config", "opencode", "opencode.json");

      yield* fs.makeDirectory(existingDirectory, { recursive: true });
      yield* fs.writeFileString(
        existingPath,
        "---\nname: existing-skill\ndescription: Existing skill\n---\n",
      );
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fs.writeFileString(
        configPath,
        encodeTestOpenCodeConfig({ skills: { paths: [existingDirectory] } }),
      );

      const installed = yield* installProviderSkill({
        providers: [
          makeProvider({
            name: "existing-skill",
            path: existingPath,
            enabled: true,
            scope: "user",
          }),
        ],
        request: {
          instanceId: OPENCODE_INSTANCE_ID,
          source: {
            type: "url",
            url: "https://skills.test/custom/SKILL.md",
          },
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeHttpLayer(
              () =>
                new Response(
                  "---\nname: linked-skill\ndescription: Linked test skill\n---\n\nUse this skill.",
                  { headers: { "content-type": "text/markdown" } },
                ),
            ),
            unusedGitLayer,
          ),
        ),
      );

      const config = decodeTestOpenCodeConfig(yield* fs.readFileString(configPath));
      assert.deepStrictEqual(config.skills.paths, [
        existingDirectory,
        path.dirname(installed.skillPath),
      ]);
    }),
  );
});

it("mergeInstalledProviderSkill appends the installed skill to the target provider only once", () => {
  const existingSkill: ServerProviderSkill = {
    name: "existing-skill",
    path: "/tmp/skills/existing-skill/SKILL.md",
    enabled: true,
  };
  const provider = makeProvider(existingSkill);

  const merged = mergeInstalledProviderSkill({
    providers: [provider],
    instanceId: OPENCODE_INSTANCE_ID,
    skillName: "linked-skill",
    skillPath: "/tmp/skills/linked-skill/SKILL.md",
  });

  assert.deepStrictEqual(
    merged[0]?.skills.map((skill) => skill.name),
    ["existing-skill", "linked-skill"],
  );

  const mergedAgain = mergeInstalledProviderSkill({
    providers: merged,
    instanceId: OPENCODE_INSTANCE_ID,
    skillName: "linked-skill",
    skillPath: "/tmp/skills/linked-skill/SKILL.md",
  });

  assert.deepStrictEqual(
    mergedAgain[0]?.skills.map((skill) => skill.name),
    ["existing-skill", "linked-skill"],
  );

  const reenabled = mergeInstalledProviderSkill({
    providers: [
      makeProvider({
        name: "linked-skill",
        path: "/tmp/skills/stale-linked-skill/SKILL.md",
        enabled: false,
        scope: "user",
      }),
    ],
    instanceId: OPENCODE_INSTANCE_ID,
    skillName: "linked-skill",
    skillPath: "/tmp/skills/linked-skill/SKILL.md",
  });

  assert.deepStrictEqual(reenabled[0]?.skills, [
    {
      name: "linked-skill",
      path: "/tmp/skills/linked-skill/SKILL.md",
      enabled: true,
      scope: "user",
    },
  ]);
});

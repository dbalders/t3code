import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { beforeEach } from "vitest";

import { OpenCodeSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { checkOpenCodeProviderStatus } from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ServerProviderShape`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    versionStderr: "",
    versionCode: 0,
    inventoryError: null as Error | null,
    closeCalls: 0,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.versionStderr = "";
    this.state.versionCode = 0;
    this.state.inventoryError = null;
    this.state.closeCalls = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({
          stdout: runtimeMock.state.versionStdout,
          stderr: runtimeMock.state.versionStderr,
          code: runtimeMock.state.versionCode,
        }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

it.layer(testLayer)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.message, "OpenCode CLI (`opencode`) is not installed or not on PATH.");
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("parses OpenCode version output from stderr", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "";
      runtimeMock.state.versionStderr = "opencode 1.14.19\n";

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.version, "1.14.19");
      assert.equal(
        snapshot.message,
        "OpenCode is available, but it did not report any connected upstream providers.",
      );
    }),
  );

  it.effect("includes OpenCode version command output when parsing fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "";
      runtimeMock.state.versionStderr = "dyld: Library not loaded: /usr/local/lib/libexample.dylib";
      runtimeMock.state.versionCode = 1;

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.match(
        snapshot.message ?? "",
        /Unable to determine OpenCode version from `opencode --version` output\./,
      );
      assert.match(snapshot.message ?? "", /dyld: Library not loaded/);
    }),
  );

  it.effect(
    "emits OpenCode reasoning defaults so trait picker can resolve a visible selection",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.inventory = {
          providerList: {
            connected: ["openai"],
            all: [
              {
                id: "openai",
                name: "OpenAI",
                models: {
                  "gpt-5.4": {
                    id: "gpt-5.4",
                    name: "GPT-5.4",
                    variants: {
                      none: {},
                      low: {},
                      medium: {},
                      high: {},
                      xhigh: {},
                    },
                  },
                },
              },
            ],
            default: {},
          },
          agents: [
            { name: "build", hidden: false, mode: "primary" },
            { name: "plan", hidden: false, mode: "primary" },
          ],
        };

        const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());
        const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

        assert.ok(model);
        const variantDescriptor = model.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
        );
        assert.ok(variantDescriptor && variantDescriptor.type === "select");
        assert.equal(variantDescriptor.label, "Reasoning");
        assert.equal(
          variantDescriptor.options.find((option) => option.isDefault === true)?.id,
          "medium",
        );
        const agentDescriptor = model.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
        );
        assert.ok(agentDescriptor && agentDescriptor.type === "select");
        assert.equal(
          agentDescriptor.options.find((option) => option.isDefault === true)?.id,
          "build",
        );
      }),
  );

  it.effect("uses DeepSeek-specific reasoning fallbacks for UCSD DeepSeek models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ucsd"],
          all: [
            {
              id: "ucsd",
              name: "ucsd",
              models: {
                "deepseek-v4-flash-max": {
                  id: "deepseek-v4-flash-max",
                  name: "DeepSeek v4 Flash Max",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());
      const model = snapshot.models.find((entry) => entry.slug === "ucsd/deepseek-v4-flash-max");

      assert.ok(model);
      assert.equal(model.name, "DeepSeek v4 Flash Max");
      assert.equal(model.subProvider, "UCSD");
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      assert.ok(variantDescriptor && variantDescriptor.type === "select");
      assert.equal(variantDescriptor.label, "Reasoning");
      assert.deepEqual(
        variantDescriptor.options.map((option) => option.id),
        ["instant", "high", "xhigh"],
      );
      assert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "high",
      );
    }),
  );

  it.effect("uses standard reasoning fallbacks for other UCSD models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ucsd"],
          all: [
            {
              id: "ucsd",
              name: "ucsd",
              models: {
                "gpt-5.5": {
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());
      const model = snapshot.models.find((entry) => entry.slug === "ucsd/gpt-5.5");

      assert.ok(model);
      assert.equal(model.subProvider, "UCSD");
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      assert.ok(variantDescriptor && variantDescriptor.type === "select");
      assert.deepEqual(
        variantDescriptor.options.map((option) => option.id),
        ["low", "medium", "high"],
      );
      assert.equal(variantDescriptor.currentValue, "high");
    }),
  );

  it.effect("includes OpenCode skills in the provider snapshot", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["ucsd"],
          all: [
            {
              id: "ucsd",
              name: "ucsd",
              models: {
                "gpt-5.5": {
                  id: "gpt-5.5",
                  name: "GPT-5.5",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
        skills: [
          {
            name: "tritonai-feedback",
            description: "Send feedback to the TritonAI team.",
            location: "/Users/test/.agents/ucsd/skills/tritonai-feedback/SKILL.md",
            content: "---\nname: tritonai-feedback\n---\n",
          },
          {
            name: "ucsd-data-classification",
            description: "Classify UCSD data under IS-3 Protection Levels.",
            location: "/Users/test/.agents/ucsd/skills/ucsd-data-classification/SKILL.md",
            content: "---\nname: ucsd-data-classification\n---\n",
          },
        ],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.deepEqual(
        snapshot.skills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled,
          shortDescription: skill.shortDescription,
        })),
        [
          {
            name: "tritonai-feedback",
            path: "/Users/test/.agents/ucsd/skills/tritonai-feedback/SKILL.md",
            enabled: true,
            shortDescription: "Send feedback to the TritonAI team.",
          },
          {
            name: "ucsd-data-classification",
            path: "/Users/test/.agents/ucsd/skills/ucsd-data-classification/SKILL.md",
            enabled: true,
            shortDescription: "Classify UCSD data under IS-3 Protection Levels.",
          },
        ],
      );
    }),
  );

  it.effect("gives custom DeepSeek models a DeepSeek reasoning selector", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: [],
          all: [],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ customModels: ["ucsd/deepseek-v4-flash-max"] }),
        process.cwd(),
      );
      const model = snapshot.models.find((entry) => entry.slug === "ucsd/deepseek-v4-flash-max");

      assert.ok(model);
      assert.equal(model.isCustom, true);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      assert.ok(variantDescriptor && variantDescriptor.type === "select");
      assert.equal(variantDescriptor.label, "Reasoning");
      assert.deepEqual(
        variantDescriptor.options.map((option) => option.id),
        ["instant", "high", "xhigh"],
      );
      assert.equal(variantDescriptor.currentValue, "high");
    }),
  );

  it.effect("gives other custom OpenCode models the standard reasoning selector", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: [],
          all: [],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ customModels: ["ucsd/gpt-5.5"] }),
        process.cwd(),
      );
      const model = snapshot.models.find((entry) => entry.slug === "ucsd/gpt-5.5");

      assert.ok(model);
      assert.equal(model.isCustom, true);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      assert.ok(variantDescriptor && variantDescriptor.type === "select");
      assert.deepEqual(
        variantDescriptor.options.map((option) => option.id),
        ["low", "medium", "high"],
      );
      assert.equal(variantDescriptor.currentValue, "high");
    }),
  );

  it.effect("closes the local OpenCode server scope after provider refresh", () =>
    Effect.gen(function* () {
      yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(runtimeMock.state.closeCalls, 1);
    }),
  );

  it.effect("keys provider status cache to OpenCode runtime settings and config path", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          binaryPath: "/managed/opencode",
          customModels: ["ucsd/api-deepseek-v4-flash"],
        }),
        process.cwd(),
        {
          OPENCODE_CONFIG: "/Users/test/.config/opencode/opencode.json",
        },
      );

      assert.equal(
        snapshot.cacheKey,
        'opencode:v1:{"binaryPath":"/managed/opencode","serverUrl":"","opencodeConfig":"/Users/test/.config/opencode/opencode.json","customModels":["ucsd/api-deepseek-v4-flash"]}',
      );
    }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("401 Unauthorized");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
});

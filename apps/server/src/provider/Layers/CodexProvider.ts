import * as OS from "node:os";
import type {
  ModelCapabilities,
  CodexSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderState,
} from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import { T3_CODEX_API_KEY_PREFIX } from "@t3tools/shared/codex";
import {
  Cache,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  extractAuthBoolean,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import type { CodexAccountSnapshot } from "../codexAccount";
import { probeCodexDiscovery } from "../codexAppServer";
import {
  buildCodexCommandArgs,
  buildCodexCommandEnv,
  resolveCodexApiKey,
} from "../codexLaunchConfig";
import { CodexRemoteModelsError, fetchCodexRemoteModelIds } from "../codexRemoteModels";
import { CodexProvider } from "../Services/CodexProvider";
import { ServerSettingsService } from "../../serverSettings";

const DEFAULT_CODEX_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High", isDefault: true },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const PROVIDER = "codex" as const;
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.2",
    name: "GPT-5.2",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

export function getCodexModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CODEX_MODEL_CAPABILITIES
  );
}

function buildResolvedCodexModels(
  modelIds: ReadonlyArray<string>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const discoveredModels: ServerProviderModel[] = [];
  const seen = new Set<string>();

  for (const modelId of modelIds) {
    const slug = modelId.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const builtInModel = BUILT_IN_MODELS.find((candidate) => candidate.slug === slug);
    discoveredModels.push({
      slug,
      name: builtInModel?.name ?? slug,
      isCustom: false,
      capabilities: builtInModel?.capabilities ?? null,
    });
  }

  return providerModelsFromSettings(
    discoveredModels,
    PROVIDER,
    customModels,
    DEFAULT_CODEX_MODEL_CAPABILITIES,
  );
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", auth: { status: "authenticated" } };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export const readCodexConfigModelProvider = Effect.fn("readCodexConfigModelProvider")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const codexHome = yield* settingsService.getSettings.pipe(
    Effect.map(
      (settings) =>
        settings.providers.codex.homePath ||
        process.env.CODEX_HOME ||
        path.join(OS.homedir(), ".codex"),
    ),
  );
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return undefined;
});

export const hasCustomModelProvider = readCodexConfigModelProvider().pipe(
  Effect.map((provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider)),
  Effect.orElseSucceed(() => false),
);

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;
const MODELS_PROBE_TIMEOUT_MS = 8_000;

const probeCodexCapabilities = (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly lightllmApiKey?: string;
  readonly cwd: string;
}) =>
  Effect.tryPromise((signal) => probeCodexDiscovery({ ...input, signal })).pipe(
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );

const probeCodexRemoteModels = (apiKey: string) =>
  Effect.tryPromise({
    try: (signal) => fetchCodexRemoteModelIds({ apiKey, signal }),
    catch: (error) =>
      error instanceof CodexRemoteModelsError
        ? error
        : new CodexRemoteModelsError(
            error instanceof Error ? error.message : "Could not discover available UCSD models.",
          ),
  }).pipe(
    Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(new CodexRemoteModelsError("Timed out while discovering UCSD models.")),
    ),
  );

const runCodexCommand = Effect.fn("runCodexCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const codexSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.codex),
  );
  return yield* spawnAndCollect(
    codexSettings.binaryPath,
    ChildProcess.make(codexSettings.binaryPath, buildCodexCommandArgs(args), {
      shell: process.platform === "win32",
      env: buildCodexCommandEnv(codexSettings),
    }),
  );
});

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  _resolveAccount?: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly lightllmApiKey?: string;
  }) => Effect.Effect<CodexAccountSnapshot | undefined>,
  resolveSkills?: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly lightllmApiKey?: string;
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<ServerProviderSkill> | undefined>,
  resolveRemoteModels?: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<string>, CodexRemoteModelsError>,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const codexSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.codex),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    codexSettings.customModels,
    DEFAULT_CODEX_MODEL_CAPABILITIES,
  );

  if (!codexSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "UCSD is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "The UCSD app-server client (`codex`) is not installed or not on PATH."
          : `Failed to execute the UCSD app-server client health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "The UCSD app-server client is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion =
    parseCodexCliVersion(`${version.stdout}\n${version.stderr}`) ??
    parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `The UCSD app-server client is installed but failed to run. ${detail}`
          : "The UCSD app-server client is installed but failed to run.",
      },
    });
  }

  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: formatCodexCliUpgradeMessage(parsedVersion),
      },
    });
  }

  const apiKey = resolveCodexApiKey(codexSettings);

  if (!apiKey) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: {
          status: "unauthenticated",
          type: "apiKey",
          label: "UCSD API Key",
        },
        message: "Enter a UCSD LiteLLM virtual key to connect.",
      },
    });
  }

  if (!apiKey.startsWith(T3_CODEX_API_KEY_PREFIX)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: {
          status: "unauthenticated",
          type: "apiKey",
          label: "UCSD API Key",
        },
        message: `UCSD API keys must be LiteLLM virtual keys starting with '${T3_CODEX_API_KEY_PREFIX}'.`,
      },
    });
  }

  const skills =
    (resolveSkills
      ? yield* resolveSkills({
          binaryPath: codexSettings.binaryPath,
          homePath: codexSettings.homePath,
          lightllmApiKey: apiKey,
          cwd: process.cwd(),
        }).pipe(Effect.orElseSucceed(() => undefined))
      : undefined) ?? [];

  const discoveredModelsResult = resolveRemoteModels
    ? yield* resolveRemoteModels(apiKey).pipe(Effect.result)
    : yield* probeCodexRemoteModels(apiKey).pipe(Effect.result);

  if (Result.isFailure(discoveredModelsResult)) {
    const error = discoveredModelsResult.failure;
    const authStatus =
      error instanceof CodexRemoteModelsError && (error.status === 401 || error.status === 403)
        ? "unauthenticated"
        : "unknown";
    const status = authStatus === "unauthenticated" ? "error" : "warning";

    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status,
        auth: {
          status: authStatus,
          type: "apiKey",
          label: "UCSD API Key",
        },
        message:
          error instanceof Error ? error.message : "Could not discover available UCSD models.",
      },
    });
  }

  const resolvedModels = buildResolvedCodexModels(
    discoveredModelsResult.success,
    codexSettings.customModels,
  );

  return buildServerProvider({
    provider: PROVIDER,
    enabled: codexSettings.enabled,
    checkedAt,
    models: resolvedModels,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        type: "apiKey",
        label: "UCSD API Key",
      },
    },
  });
});

export const CodexProviderLive = Layer.effect(
  CodexProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const discoveryCache = yield* Cache.make({
      capacity: 4,
      timeToLive: Duration.minutes(5),
      lookup: (key: string) => {
        const [binaryPath, homePath, lightllmApiKey, cwd] = JSON.parse(key) as [
          string,
          string | undefined,
          string | undefined,
          string,
        ];
        return probeCodexCapabilities({
          binaryPath,
          cwd,
          ...(homePath ? { homePath } : {}),
          ...(lightllmApiKey ? { lightllmApiKey } : {}),
        });
      },
    });
    const remoteModelsCache = yield* Cache.make({
      capacity: 4,
      timeToLive: Duration.minutes(5),
      lookup: (apiKey: string) => probeCodexRemoteModels(apiKey),
    });

    const getDiscovery = (input: {
      readonly binaryPath: string;
      readonly homePath?: string;
      readonly lightllmApiKey?: string;
      readonly cwd: string;
    }) =>
      Cache.get(
        discoveryCache,
        JSON.stringify([input.binaryPath, input.homePath, input.lightllmApiKey, input.cwd]),
      );

    const checkProvider = checkCodexProviderStatus(
      undefined,
      (input) => getDiscovery(input).pipe(Effect.map((discovery) => discovery?.skills)),
      (apiKey) => Cache.get(remoteModelsCache, apiKey),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CodexSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.codex),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);

import {
  ProviderDriverKind,
  type ModelCapabilities,
  type OpenCodeSettings,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";

const PROVIDER = ProviderDriverKind.make("opencode");
const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode CLI health check: ${detail}`
      : "Failed to execute OpenCode CLI health check.",
  };
}

function makeOpenCodeProviderCacheKey(
  openCodeSettings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv,
): string {
  return `opencode:v1:${JSON.stringify({
    binaryPath: openCodeSettings.binaryPath,
    serverUrl: openCodeSettings.serverUrl,
    opencodeConfig: environment.OPENCODE_CONFIG ?? "",
    customModels: [...openCodeSettings.customModels],
  })}`;
}

function withOpenCodeCacheKey(
  provider: ServerProviderDraft,
  openCodeSettings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv,
): ServerProviderDraft {
  return {
    ...provider,
    cacheKey: makeOpenCodeProviderCacheKey(openCodeSettings, environment),
  };
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatOpenCodeSubProviderName(value: string): string | undefined {
  const name = nonEmptyTrimmed(value);
  if (!name) return undefined;
  return name.toLowerCase() === "ucsd" ? "UCSD" : name;
}

const DEFAULT_REASONING_VARIANT_VALUES = ["low", "medium", "high"] as const;
const DEEPSEEK_REASONING_VARIANT_VALUES = ["instant", "high", "xhigh"] as const;

function isDeepSeekModelSlug(model: string): boolean {
  return model.toLowerCase().includes("deepseek");
}

function fallbackVariantValuesForModel(providerID: string, modelID: string): ReadonlyArray<string> {
  if (providerID !== "ucsd") {
    return [];
  }
  return isDeepSeekModelSlug(modelID)
    ? DEEPSEEK_REASONING_VARIANT_VALUES
    : DEFAULT_REASONING_VARIANT_VALUES;
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "ucsd") {
    return variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

function buildReasoningVariantCapabilities(
  values: ReadonlyArray<string>,
  defaultValue = "high",
): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: values.map((value) =>
          value === defaultValue
            ? { id: value, label: titleCaseSlug(value), isDefault: true }
            : { id: value, label: titleCaseSlug(value) },
        ),
        currentValue: defaultValue,
      },
    ],
  });
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES = buildReasoningVariantCapabilities(
  DEFAULT_REASONING_VARIANT_VALUES,
);

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const rawVariantValues = Object.keys(input.model.variants ?? {});
  const variantValues =
    rawVariantValues.length > 0
      ? rawVariantValues
      : fallbackVariantValuesForModel(input.providerID, input.model.id);
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Reasoning",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = formatOpenCodeSubProviderName(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function flattenOpenCodeSkills(input: OpenCodeInventory): ReadonlyArray<ServerProviderSkill> {
  const skills: ServerProviderSkill[] = [];
  for (const skill of input.skills ?? []) {
    const name = trimOptional(skill.name);
    const path = trimOptional(skill.location);
    if (!name || !path) {
      continue;
    }

    const description = trimOptional(skill.description);
    skills.push({
      name,
      path,
      enabled: true,
      ...(description ? { description, shortDescription: description } : {}),
    });
  }

  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

function capabilitiesForCustomOpenCodeModel(model: string): ModelCapabilities {
  return isDeepSeekModelSlug(model)
    ? buildReasoningVariantCapabilities(DEEPSEEK_REASONING_VARIANT_VALUES)
    : DEFAULT_OPENCODE_MODEL_CAPABILITIES;
}

function openCodeModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, PROVIDER);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: capabilitiesForCustomOpenCodeModel(normalized),
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export const makePendingOpenCodeProvider = (
  openCodeSettings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = openCodeModelsFromSettings([], openCodeSettings.customModels);

    if (!openCodeSettings.enabled) {
      return withOpenCodeCacheKey(
        buildServerProvider({
          presentation: OPENCODE_PRESENTATION,
          enabled: false,
          checkedAt,
          models,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message:
              openCodeSettings.serverUrl.trim().length > 0
                ? "OpenCode is disabled in TritonAI Code settings. A server URL is configured."
                : "OpenCode is disabled in TritonAI Code settings.",
          },
        }),
        openCodeSettings,
        environment,
      );
    }

    return withOpenCodeCacheKey(
      buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenCode provider status has not been checked in this session yet.",
        },
      }),
      openCodeSettings,
      environment,
    );
  });

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = openCodeSettings.customModels;
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      serverUrl: openCodeSettings.serverUrl,
    });
    return withOpenCodeCacheKey(
      buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models: openCodeModelsFromSettings([], customModels),
        probe: {
          installed: failure.installed,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: failure.message,
        },
      }),
      openCodeSettings,
      environment,
    );
  };

  if (!openCodeSettings.enabled) {
    return withOpenCodeCacheKey(
      buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: openCodeModelsFromSettings([], customModels),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: isExternalServer
            ? "OpenCode is disabled in TritonAI Code settings. A server URL is configured."
            : "OpenCode is disabled in TritonAI Code settings.",
        },
      }),
      openCodeSettings,
      environment,
    );
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      openCodeRuntime
        .runOpenCodeCommand({
          binaryPath: openCodeSettings.binaryPath,
          args: ["--version"],
          environment,
        })
        .pipe(
          Effect.mapError(
            (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }
    version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

    if (!version) {
      return fallback(
        new Error(
          `Unable to determine OpenCode version from \`opencode --version\` output. TritonAI Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
        ),
        null,
      );
    }
    if (compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
      return withOpenCodeCacheKey(
        buildServerProvider({
          presentation: OPENCODE_PRESENTATION,
          enabled: openCodeSettings.enabled,
          checkedAt,
          models: openCodeModelsFromSettings([], customModels),
          probe: {
            installed: true,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
          },
        }),
        openCodeSettings,
        environment,
      );
    }
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* openCodeRuntime
          .connectToOpenCodeServer({
            binaryPath: openCodeSettings.binaryPath,
            serverUrl: openCodeSettings.serverUrl,
            environment,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
        return yield* openCodeRuntime
          .loadOpenCodeInventory(
            openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: cwd,
              ...(isExternalServer && openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
      }),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const models = openCodeModelsFromSettings(
    flattenOpenCodeModels(inventoryExit.value),
    customModels,
  );
  const skills = flattenOpenCodeSkills(inventoryExit.value);
  const connectedCount = inventoryExit.value.providerList.connected.length;
  return withOpenCodeCacheKey(
    buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills,
      probe: {
        installed: true,
        version,
        status: connectedCount > 0 ? "ready" : "warning",
        auth: {
          status: connectedCount > 0 ? "authenticated" : "unknown",
          type: "opencode",
        },
        message:
          connectedCount > 0
            ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
            : isExternalServer
              ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
              : "OpenCode is available, but it did not report any connected upstream providers.",
      },
    }),
    openCodeSettings,
    environment,
  );
});

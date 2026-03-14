import { useCallback, useEffect, useRef } from "react";
import { Option, Schema } from "effect";
import {
  type ProviderKind,
  ServerAgentSettings,
  type ServerAgentSettings as ServerAgentSettingsValue,
  type ServerAgentSettingsState,
  type ServerPatchAgentSettingsInput,
  SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_LENGTH,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  getModelOptions,
  normalizeCustomModelSlugs,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { toastManager } from "./components/ui/toast";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { serverAgentSettingsQueryOptions, serverQueryKeys } from "./lib/serverReactQuery";
import { ensureNativeApi } from "./nativeApi";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const LEGACY_APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const CLIENT_APP_SETTINGS_STORAGE_KEY = "t3code:app-client-settings:v1";
const SERVER_SETTINGS_CACHE_STORAGE_KEY = "t3code:app-server-settings-cache:v1";

export const MAX_CUSTOM_MODEL_LENGTH = SERVER_AGENT_SETTINGS_MAX_CUSTOM_MODEL_LENGTH;
export const TIMESTAMP_FORMAT_OPTIONS = ["locale", "12-hour", "24-hour"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMAT_OPTIONS)[number];
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

const ClientAppSettingsSchema = Schema.Struct({
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  timestampFormat: Schema.Literals(["locale", "12-hour", "24-hour"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});

const LegacyAppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some(""))),
  codexHomePath: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some(""))),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  timestampFormat: Schema.Literals(["locale", "12-hour", "24-hour"]).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});

type ClientAppSettings = typeof ClientAppSettingsSchema.Type;
type ServerAppSettings = ServerAgentSettingsValue;
type LegacyAppSettings = typeof LegacyAppSettingsSchema.Type;

export type AppSettings = ClientAppSettings & ServerAppSettings;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const DEFAULT_CLIENT_APP_SETTINGS = ClientAppSettingsSchema.makeUnsafe({});
const DEFAULT_SERVER_APP_SETTINGS = ServerAgentSettings.makeUnsafe({});
const DEFAULT_APP_SETTINGS: AppSettings = {
  ...DEFAULT_SERVER_APP_SETTINGS,
  ...DEFAULT_CLIENT_APP_SETTINGS,
};

const SERVER_SETTINGS_KEYS = new Set<keyof ServerAppSettings>([
  "codexBinaryPath",
  "codexHomePath",
  "defaultThreadEnvMode",
  "customCodexModels",
]);

function readLegacyAppSettings(): LegacyAppSettings | null {
  try {
    return getLocalStorageItem(LEGACY_APP_SETTINGS_STORAGE_KEY, LegacyAppSettingsSchema);
  } catch {
    return null;
  }
}

function hasLocalStorageValue(key: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(key) !== null;
}

function normalizeServerSettings(settings: ServerAppSettings): ServerAppSettings {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
  };
}

function applyServerSettingsPatch(
  current: ServerAppSettings,
  patch: ServerPatchAgentSettingsInput,
): ServerAppSettings {
  return normalizeServerSettings({
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

export function extractClientAppSettings(
  input: AppSettings | LegacyAppSettings,
): ClientAppSettings {
  return {
    confirmThreadDelete: input.confirmThreadDelete,
    enableAssistantStreaming: input.enableAssistantStreaming,
    timestampFormat: input.timestampFormat,
  };
}

export function extractServerAppSettings(
  input: AppSettings | LegacyAppSettings,
): ServerAppSettings {
  return normalizeServerSettings({
    codexBinaryPath: input.codexBinaryPath,
    codexHomePath: input.codexHomePath,
    defaultThreadEnvMode: input.defaultThreadEnvMode,
    customCodexModels: input.customCodexModels,
  });
}

export function splitAppSettingsPatch(patch: Partial<AppSettings>): {
  clientPatch: Partial<ClientAppSettings>;
  serverPatch: ServerPatchAgentSettingsInput;
} {
  const clientPatch: Partial<ClientAppSettings> = {};
  const serverPatch: ServerPatchAgentSettingsInput = {};

  for (const [key, value] of Object.entries(patch) as Array<
    [keyof AppSettings, AppSettings[keyof AppSettings]]
  >) {
    if (value === undefined) continue;

    if (SERVER_SETTINGS_KEYS.has(key as keyof ServerAppSettings)) {
      Object.assign(serverPatch, { [key]: value });
      continue;
    }

    Object.assign(clientPatch, { [key]: value });
  }

  return { clientPatch, serverPatch };
}

export { normalizeCustomModelSlugs };

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function useAppSettings() {
  const queryClient = useQueryClient();
  const [clientSettings, setClientSettings] = useLocalStorage(
    CLIENT_APP_SETTINGS_STORAGE_KEY,
    DEFAULT_CLIENT_APP_SETTINGS,
    ClientAppSettingsSchema,
  );
  const [serverSettingsCache, setServerSettingsCache] = useLocalStorage(
    SERVER_SETTINGS_CACHE_STORAGE_KEY,
    DEFAULT_SERVER_APP_SETTINGS,
    ServerAgentSettings,
  );
  const legacySettingsRef = useRef<LegacyAppSettings | null>(readLegacyAppSettings());
  const attemptedLegacyServerBootstrapRef = useRef(false);

  const serverSettingsStateQuery = useQuery(serverAgentSettingsQueryOptions());
  const serverSettingsState = serverSettingsStateQuery.data ?? null;

  useEffect(() => {
    if (!serverSettingsState) return;
    setServerSettingsCache(serverSettingsState.settings);
  }, [serverSettingsState, setServerSettingsCache]);

  useEffect(() => {
    const legacySettings = legacySettingsRef.current;
    if (!legacySettings) return;
    if (hasLocalStorageValue(CLIENT_APP_SETTINGS_STORAGE_KEY)) return;

    setClientSettings(extractClientAppSettings(legacySettings));
  }, [setClientSettings]);

  useEffect(() => {
    const legacySettings = legacySettingsRef.current;
    if (!legacySettings) return;
    if (!serverSettingsState) return;
    if (attemptedLegacyServerBootstrapRef.current) return;

    attemptedLegacyServerBootstrapRef.current = true;
    if (serverSettingsState.isInitialized) {
      removeLocalStorageItem(LEGACY_APP_SETTINGS_STORAGE_KEY);
      legacySettingsRef.current = null;
      return;
    }

    const api = ensureNativeApi();
    const legacyServerSettings = extractServerAppSettings(legacySettings);
    void api.server
      .patchAgentSettings(legacyServerSettings)
      .then((nextSettings) => {
        const normalizedSettings = normalizeServerSettings(nextSettings);
        const nextState: ServerAgentSettingsState = {
          settings: normalizedSettings,
          isInitialized: true,
        };
        queryClient.setQueryData(serverQueryKeys.agentSettings(), nextState);
        setServerSettingsCache(normalizedSettings);
        removeLocalStorageItem(LEGACY_APP_SETTINGS_STORAGE_KEY);
        legacySettingsRef.current = null;
      })
      .catch(() => {
        attemptedLegacyServerBootstrapRef.current = false;
      });
  }, [queryClient, serverSettingsState, setServerSettingsCache]);

  const patchServerSettings = useCallback(
    (serverPatch: ServerPatchAgentSettingsInput) => {
      if (Object.keys(serverPatch).length === 0) {
        return;
      }

      const api = ensureNativeApi();
      const currentSettings = normalizeServerSettings(
        serverSettingsState?.settings ?? serverSettingsCache,
      );
      const optimisticSettings = applyServerSettingsPatch(currentSettings, serverPatch);
      queryClient.setQueryData<ServerAgentSettingsState>(serverQueryKeys.agentSettings(), {
        settings: optimisticSettings,
        isInitialized: true,
      });
      setServerSettingsCache(optimisticSettings);

      void api.server
        .patchAgentSettings(serverPatch)
        .then((nextSettings) => {
          const normalizedSettings = normalizeServerSettings(nextSettings);
          queryClient.setQueryData<ServerAgentSettingsState>(serverQueryKeys.agentSettings(), {
            settings: normalizedSettings,
            isInitialized: true,
          });
          setServerSettingsCache(normalizedSettings);
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to save server settings",
            description:
              error instanceof Error
                ? error.message
                : "The server settings update failed and was rolled back.",
          });
          void queryClient.invalidateQueries({ queryKey: serverQueryKeys.agentSettings() });
        });
    },
    [queryClient, serverSettingsCache, serverSettingsState, setServerSettingsCache],
  );

  const settings: AppSettings = {
    ...normalizeServerSettings(serverSettingsState?.settings ?? serverSettingsCache),
    ...clientSettings,
  };

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      const { clientPatch, serverPatch } = splitAppSettingsPatch(patch);

      if (Object.keys(clientPatch).length > 0) {
        setClientSettings((prev) => ({
          ...prev,
          ...clientPatch,
        }));
      }

      patchServerSettings(serverPatch);
    },
    [patchServerSettings, setClientSettings],
  );

  const resetSettings = useCallback(() => {
    setClientSettings(DEFAULT_CLIENT_APP_SETTINGS);
    patchServerSettings(DEFAULT_SERVER_APP_SETTINGS);
  }, [patchServerSettings, setClientSettings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}

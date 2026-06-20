/**
 * OpenCodeDriver — `ProviderDriver` for the OpenCode runtime.
 *
 * Mirrors the Codex / Claude drivers: a plain value whose `create()`
 * bundles `snapshot` / `adapter` / `textGeneration` closures over the
 * per-instance `OpenCodeSettings`.
 *
 * Two instances with different `serverUrl`s therefore talk to independent
 * OpenCode servers; when no `serverUrl` is set, the adapter + text-generation
 * shares spin up their own scoped child processes, and those child
 * processes are released when the registry scope closes.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import * as NodeOS from "node:os";

import { OpenCodeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const INSTALLER_MANAGED_BASE_DIR = [".agents", "ucsd"];
const INSTALLER_MANAGED_OPENCODE_RUNTIME_DIR = ["runtime", "opencode"];
const INSTALLER_MANAGED_OPENCODE_CONFIG_PATH = ["opencode", "opencode.json"];
const INSTALLER_MANAGED_OPENCODE_PACKAGE_PREFIX = "opencode-ai-";

interface InstallerManagedOpenCodeRuntime {
  readonly binaryPath: string;
  readonly binDir: string;
  readonly configPath: string | null;
  readonly configHome: string;
  readonly cacheHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  homebrewFormula: "anomalyco/tap/opencode",
  nativeUpdate: {
    executable: "opencode",
    args: ["upgrade"],
    lockKey: "opencode-native",
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

export function isInstallerManagedOpenCodeBinaryPath(binaryPath: string | null | undefined) {
  if (!binaryPath) return false;
  return normalizeCommandPath(binaryPath).includes("/.agents/ucsd/runtime/opencode/opencode-ai-");
}

export function isDefaultOpenCodeBinaryPath(binaryPath: string | null | undefined) {
  if (!binaryPath) return false;
  const normalized = normalizeCommandPath(binaryPath);
  return (
    normalized === "opencode" || normalized === "opencode.exe" || normalized === "opencode.cmd"
  );
}

function parseInstallerManagedOpenCodeVersion(entry: string): string | null {
  if (!entry.startsWith(INSTALLER_MANAGED_OPENCODE_PACKAGE_PREFIX)) {
    return null;
  }
  const version = entry.slice(INSTALLER_MANAGED_OPENCODE_PACKAGE_PREFIX.length).trim();
  return version.length > 0 ? version : null;
}

export function selectInstallerManagedOpenCodeVersionDirectory(
  entries: ReadonlyArray<string>,
): string | null {
  const candidates = entries
    .map((entry) => {
      const version = parseInstallerManagedOpenCodeVersion(entry);
      return version ? { entry, version } : null;
    })
    .filter((candidate): candidate is { readonly entry: string; readonly version: string } =>
      Boolean(candidate),
    )
    .toSorted((left, right) => {
      const versionComparison = compareSemverVersions(right.version, left.version);
      return versionComparison !== 0 ? versionComparison : right.entry.localeCompare(left.entry);
    });

  return candidates[0]?.entry ?? null;
}

export function resolveInstallerManagedOpenCodeBinaryPath(input: {
  readonly configuredBinaryPath: string;
  readonly installerRuntimeBinaryPath: string | null;
}): string {
  if (
    input.installerRuntimeBinaryPath !== null &&
    (isDefaultOpenCodeBinaryPath(input.configuredBinaryPath) ||
      isInstallerManagedOpenCodeBinaryPath(input.configuredBinaryPath))
  ) {
    return input.installerRuntimeBinaryPath;
  }
  return input.configuredBinaryPath;
}

function openCodeExecutableCandidates(path: Path.Path, packageDir: string): ReadonlyArray<string> {
  return [
    path.join(packageDir, "bin", "opencode"),
    path.join(packageDir, "bin", "opencode.exe"),
    path.join(packageDir, "bin", "opencode.cmd"),
    path.join(packageDir, "opencode"),
    path.join(packageDir, "opencode.exe"),
    path.join(packageDir, "opencode.cmd"),
  ];
}

function pathListDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function prependPathEntry(
  pathValue: string | undefined,
  entry: string,
  platform: NodeJS.Platform,
): string {
  const delimiter = pathListDelimiter(platform);
  const entries = (pathValue ?? "").split(delimiter).filter(Boolean);
  const normalizedEntry = normalizeCommandPath(entry);
  if (entries.some((candidate) => normalizeCommandPath(candidate) === normalizedEntry)) {
    return entries.join(delimiter);
  }
  return [entry, ...entries].join(delimiter);
}

export function mergeInstallerManagedOpenCodeEnvironment(
  environment: NodeJS.ProcessEnv,
  runtime: InstallerManagedOpenCodeRuntime,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  next.PATH = prependPathEntry(next.PATH, runtime.binDir, platform);
  if (runtime.configPath && !next.OPENCODE_CONFIG?.trim()) {
    next.OPENCODE_CONFIG = runtime.configPath;
  }
  if (!next.XDG_CONFIG_HOME?.trim()) {
    next.XDG_CONFIG_HOME = runtime.configHome;
  }
  if (!next.XDG_CACHE_HOME?.trim()) {
    next.XDG_CACHE_HOME = runtime.cacheHome;
  }
  if (!next.XDG_DATA_HOME?.trim()) {
    next.XDG_DATA_HOME = runtime.dataHome;
  }
  if (!next.XDG_STATE_HOME?.trim()) {
    next.XDG_STATE_HOME = runtime.stateHome;
  }
  return next;
}

const findInstallerManagedOpenCodeRuntime = Effect.fn("findInstallerManagedOpenCodeRuntime")(
  function* (): Effect.fn.Return<
    InstallerManagedOpenCodeRuntime | null,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installerBaseDir = path.join(NodeOS.homedir(), ...INSTALLER_MANAGED_BASE_DIR);
    const runtimeHome = path.join(installerBaseDir, ...INSTALLER_MANAGED_OPENCODE_RUNTIME_DIR);
    const entries = yield* fs.readDirectory(runtimeHome).pipe(Effect.orElseSucceed(() => []));
    const sortedEntries = entries
      .map((entry) => {
        const version = parseInstallerManagedOpenCodeVersion(entry);
        return version ? { entry, version } : null;
      })
      .filter((entry): entry is { readonly entry: string; readonly version: string } =>
        Boolean(entry),
      )
      .toSorted((left, right) => {
        const versionComparison = compareSemverVersions(right.version, left.version);
        return versionComparison !== 0 ? versionComparison : right.entry.localeCompare(left.entry);
      });

    for (const entry of sortedEntries) {
      const packageDir = path.join(runtimeHome, entry.entry);
      for (const binaryPath of openCodeExecutableCandidates(path, packageDir)) {
        const exists = yield* fs.exists(binaryPath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const configHome = path.join(installerBaseDir, "config");
        const configPath = path.join(configHome, ...INSTALLER_MANAGED_OPENCODE_CONFIG_PATH);
        const configExists = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false));
        return {
          binaryPath,
          binDir: path.dirname(binaryPath),
          configPath: configExists ? configPath : null,
          configHome,
          cacheHome: path.join(installerBaseDir, "cache"),
          dataHome: path.join(installerBaseDir, "data"),
          stateHome: path.join(installerBaseDir, "state"),
        } satisfies InstallerManagedOpenCodeRuntime;
      }
    }

    return null;
  },
);

export type OpenCodeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const baseProcessEnv = mergeProviderInstanceEnvironment(environment);
      const installerRuntime = yield* findInstallerManagedOpenCodeRuntime();
      const hostPlatform = yield* HostProcessPlatform;
      const configuredOpenCodeBinaryPath = config.binaryPath;
      const shouldUseInstallerManagedRuntime =
        installerRuntime !== null &&
        (isDefaultOpenCodeBinaryPath(configuredOpenCodeBinaryPath) ||
          isInstallerManagedOpenCodeBinaryPath(configuredOpenCodeBinaryPath));
      const processEnv = shouldUseInstallerManagedRuntime
        ? mergeInstallerManagedOpenCodeEnvironment(baseProcessEnv, installerRuntime, hostPlatform)
        : baseProcessEnv;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: resolveInstallerManagedOpenCodeBinaryPath({
          configuredBinaryPath: configuredOpenCodeBinaryPath,
          installerRuntimeBinaryPath: installerRuntime?.binaryPath ?? null,
        }),
      } satisfies OpenCodeSettings;
      const maintenanceCapabilities = isInstallerManagedOpenCodeBinaryPath(
        effectiveConfig.binaryPath,
      )
        ? makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          })
        : yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
            binaryPath: effectiveConfig.binaryPath,
            env: processEnv,
          });

      const adapter = yield* makeOpenCodeAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOpenCodeProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshot = yield* makeManagedServerProvider<OpenCodeSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingOpenCodeProvider(settings, processEnv).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CodexSettings } from "@t3tools/contracts";
import {
  T3_CODEX_API_KEY_ENV_VAR,
  T3_CODEX_OPENAI_BASE_URL,
  T3_CODEX_PROVIDER_ID,
  T3_CODEX_PROVIDER_NAME,
} from "@t3tools/shared/codex";

const MIN_CODEX_NODE_MAJOR = 16;

const FALLBACK_NODE_BIN_DIRECTORIES = [
  "/opt/homebrew/opt/node@22/bin",
  "/opt/homebrew/opt/node@20/bin",
  "/opt/homebrew/bin",
  "/usr/local/opt/node@22/bin",
  "/usr/local/opt/node@20/bin",
  "/usr/local/bin",
] as const;

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function quoteTomlBoolean(value: boolean): string {
  return value ? "true" : "false";
}

export function resolveCodexApiKey(
  codexSettings: Pick<CodexSettings, "lightllmApiKey">,
): string | undefined {
  return codexSettings.lightllmApiKey || process.env[T3_CODEX_API_KEY_ENV_VAR] || undefined;
}

function parseNodeMajor(versionOutput: string): number | undefined {
  const match = versionOutput.trim().match(/^v?(\d+)\b/);
  const majorVersion = match?.[1];
  return majorVersion ? Number.parseInt(majorVersion, 10) : undefined;
}

function readNodeMajor(binaryPath: string, pathValue: string | undefined): number | undefined {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_500,
    env: {
      ...process.env,
      ...(pathValue !== undefined ? { PATH: pathValue } : {}),
    },
  });

  if (result.error || result.status !== 0) {
    return undefined;
  }

  return parseNodeMajor(result.stdout ?? "");
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function dedupePathEntries(entries: ReadonlyArray<string>): string[] {
  const uniqueEntries: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    uniqueEntries.push(entry);
  }

  return uniqueEntries;
}

export function resolveCodexProcessPath(pathValue: string | undefined): string | undefined {
  const pathEntries = splitPathEntries(pathValue);
  const currentNodeMajor = readNodeMajor("node", pathValue);

  if (currentNodeMajor !== undefined && currentNodeMajor >= MIN_CODEX_NODE_MAJOR) {
    return pathValue;
  }

  const candidateDirectories = dedupePathEntries([
    ...pathEntries,
    ...FALLBACK_NODE_BIN_DIRECTORIES,
  ]);

  for (const candidateDirectory of candidateDirectories) {
    const nodeBinaryPath = path.join(candidateDirectory, "node");
    if (!existsSync(nodeBinaryPath)) continue;

    const nodeMajor = readNodeMajor(nodeBinaryPath, pathValue);
    if (nodeMajor === undefined || nodeMajor < MIN_CODEX_NODE_MAJOR) {
      continue;
    }

    return dedupePathEntries([candidateDirectory, ...pathEntries]).join(path.delimiter);
  }

  return pathValue;
}

export function buildCodexCommandArgs(args: ReadonlyArray<string>): string[] {
  return [
    "-c",
    `model_provider=${quoteTomlString(T3_CODEX_PROVIDER_ID)}`,
    "-c",
    `model_providers.${T3_CODEX_PROVIDER_ID}.name=${quoteTomlString(T3_CODEX_PROVIDER_NAME)}`,
    "-c",
    `model_providers.${T3_CODEX_PROVIDER_ID}.base_url=${quoteTomlString(T3_CODEX_OPENAI_BASE_URL)}`,
    "-c",
    `model_providers.${T3_CODEX_PROVIDER_ID}.env_key=${quoteTomlString(T3_CODEX_API_KEY_ENV_VAR)}`,
    "-c",
    `model_providers.${T3_CODEX_PROVIDER_ID}.requires_openai_auth=${quoteTomlBoolean(false)}`,
    ...args,
  ];
}

export function buildCodexCommandEnv(
  codexSettings: Pick<CodexSettings, "homePath" | "lightllmApiKey">,
) {
  const apiKey = resolveCodexApiKey(codexSettings);
  const resolvedPath = resolveCodexProcessPath(process.env.PATH);

  return {
    ...process.env,
    ...(resolvedPath ? { PATH: resolvedPath } : {}),
    ...(codexSettings.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
    ...(apiKey ? { [T3_CODEX_API_KEY_ENV_VAR]: apiKey } : {}),
  };
}

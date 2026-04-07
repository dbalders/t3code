import type { CodexSettings } from "@t3tools/contracts";
import {
  T3_CODEX_API_KEY_ENV_VAR,
  T3_CODEX_OPENAI_BASE_URL,
  T3_CODEX_PROVIDER_ID,
  T3_CODEX_PROVIDER_NAME,
} from "@t3tools/shared/codex";

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

  return {
    ...process.env,
    ...(codexSettings.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
    ...(apiKey ? { [T3_CODEX_API_KEY_ENV_VAR]: apiKey } : {}),
  };
}

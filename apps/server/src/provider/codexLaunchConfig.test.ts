import { describe, expect, it } from "vitest";

import {
  T3_CODEX_API_KEY_ENV_VAR,
  T3_CODEX_OPENAI_BASE_URL,
  T3_CODEX_PROVIDER_ID,
  T3_CODEX_PROVIDER_NAME,
} from "@t3tools/shared/codex";

import { buildCodexCommandArgs, buildCodexCommandEnv } from "./codexLaunchConfig";

describe("codexLaunchConfig", () => {
  it("prepends the UCSD model provider overrides to Codex commands", () => {
    expect(buildCodexCommandArgs(["app-server"])).toEqual([
      "-c",
      `model_provider=${JSON.stringify(T3_CODEX_PROVIDER_ID)}`,
      "-c",
      `model_providers.${T3_CODEX_PROVIDER_ID}.name=${JSON.stringify(T3_CODEX_PROVIDER_NAME)}`,
      "-c",
      `model_providers.${T3_CODEX_PROVIDER_ID}.base_url=${JSON.stringify(T3_CODEX_OPENAI_BASE_URL)}`,
      "-c",
      `model_providers.${T3_CODEX_PROVIDER_ID}.env_key=${JSON.stringify(T3_CODEX_API_KEY_ENV_VAR)}`,
      "-c",
      `model_providers.${T3_CODEX_PROVIDER_ID}.requires_openai_auth=false`,
      "app-server",
    ]);
  });

  it("injects CODEX_HOME and the UCSD api key into the spawned environment", () => {
    expect(
      buildCodexCommandEnv({
        homePath: "/tmp/codex-home",
        lightllmApiKey: "sk-lightllm",
      }),
    ).toMatchObject({
      CODEX_HOME: "/tmp/codex-home",
      [T3_CODEX_API_KEY_ENV_VAR]: "sk-lightllm",
    });
  });
});

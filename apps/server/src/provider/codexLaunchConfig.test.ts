import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  T3_CODEX_API_KEY_ENV_VAR,
  T3_CODEX_OPENAI_BASE_URL,
  T3_CODEX_PROVIDER_ID,
  T3_CODEX_PROVIDER_NAME,
} from "@t3tools/shared/codex";

import {
  buildCodexCommandArgs,
  buildCodexCommandEnv,
  resolveCodexProcessPath,
} from "./codexLaunchConfig";

function withFakeNode(version: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "t3-codex-node-"));
  const binaryPath = path.join(directory, "node");
  writeFileSync(binaryPath, `#!/bin/sh\necho "${version}"\n`, { encoding: "utf8" });
  chmodSync(binaryPath, 0o755);
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

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

  it.skipIf(process.platform === "win32")(
    "reorders PATH to prefer a compatible Node runtime for Codex",
    () => {
      const incompatibleNode = withFakeNode("v12.22.12");
      const compatibleNode = withFakeNode("v22.15.0");

      try {
        const resolvedPath = resolveCodexProcessPath(
          [incompatibleNode.directory, compatibleNode.directory].join(path.delimiter),
        );

        expect(resolvedPath).toBe(
          [compatibleNode.directory, incompatibleNode.directory].join(path.delimiter),
        );
      } finally {
        incompatibleNode.cleanup();
        compatibleNode.cleanup();
      }
    },
  );
});

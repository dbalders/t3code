import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMESTAMP_FORMAT,
  extractClientAppSettings,
  extractServerAppSettings,
  getAppModelOptions,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
  splitAppSettingsPatch,
} from "./appSettings";

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.4");
  });
});

describe("timestamp format defaults", () => {
  it("defaults timestamp format to locale", () => {
    expect(DEFAULT_TIMESTAMP_FORMAT).toBe("locale");
  });
});

describe("splitAppSettingsPatch", () => {
  it("splits local and server settings fields", () => {
    expect(
      splitAppSettingsPatch({
        codexBinaryPath: "/usr/local/bin/codex",
        customCodexModels: ["custom/model-a"],
        enableAssistantStreaming: true,
        timestampFormat: "24-hour",
      }),
    ).toEqual({
      clientPatch: {
        enableAssistantStreaming: true,
        timestampFormat: "24-hour",
      },
      serverPatch: {
        codexBinaryPath: "/usr/local/bin/codex",
        customCodexModels: ["custom/model-a"],
      },
    });
  });
});

describe("extract*AppSettings helpers", () => {
  it("extracts client and server settings from legacy settings", () => {
    const legacySettings = {
      codexBinaryPath: "/usr/local/bin/codex",
      codexHomePath: "/tmp/.codex",
      defaultThreadEnvMode: "worktree" as const,
      customCodexModels: [" custom/model-a ", "gpt-5.4", "custom/model-a"],
      confirmThreadDelete: false,
      enableAssistantStreaming: true,
      timestampFormat: "12-hour" as const,
    };

    expect(extractClientAppSettings(legacySettings)).toEqual({
      confirmThreadDelete: false,
      enableAssistantStreaming: true,
      timestampFormat: "12-hour",
    });
    expect(extractServerAppSettings(legacySettings)).toEqual({
      codexBinaryPath: "/usr/local/bin/codex",
      codexHomePath: "/tmp/.codex",
      defaultThreadEnvMode: "worktree",
      customCodexModels: ["custom/model-a"],
    });
  });
});

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { resolveSelectableProvider } from "./providerModels";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveSelectableProvider", () => {
  it("falls back from stale Codex selections to the first enabled available provider", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
      }),
    ];

    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("codex"))).toBe("opencode");
  });

  it("does not select unavailable provider snapshots", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        availability: "unavailable",
      }),
      provider({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: "opencode",
      }),
    ];

    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("codex"))).toBe("opencode");
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";

import { applyProviderSkillPreferences } from "./providerSkillPreferences";

function makeSkill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, "name">) {
  return {
    path: `/Users/test/.agents/skills/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill;
}

function makeProvider(skills: ReadonlyArray<ServerProviderSkill>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-18T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [...skills],
  };
}

describe("provider skill preferences", () => {
  it("marks disabled skills as disabled without dropping them", () => {
    const ui = makeSkill({ name: "ui" });
    const provider = makeProvider([ui, makeSkill({ name: "release" })]);

    expect(
      applyProviderSkillPreferences(provider, {
        [provider.instanceId]: {
          [ui.path]: { disabled: true },
        },
      }).skills,
    ).toEqual([{ ...ui, enabled: false }, makeSkill({ name: "release" })]);
  });
});

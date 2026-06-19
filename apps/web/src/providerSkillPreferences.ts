import type { ProviderInstanceId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import type { ProviderSkillPreferences as SettingsProviderSkillPreferences } from "@t3tools/contracts/settings";

export type ProviderSkillPreferences = SettingsProviderSkillPreferences;
export type ProviderSkillPreference =
  | ProviderSkillPreferences[ProviderInstanceId][string]
  | undefined;

export function providerSkillPreferenceKey(skill: Pick<ServerProviderSkill, "path" | "name">) {
  return skill.path || skill.name;
}

export function getProviderSkillPreference(
  preferences: ProviderSkillPreferences,
  providerInstanceId: ProviderInstanceId,
  skill: Pick<ServerProviderSkill, "path" | "name">,
): ProviderSkillPreference {
  return preferences[providerInstanceId]?.[providerSkillPreferenceKey(skill)];
}

export function applyProviderSkillPreferences(
  provider: ServerProvider,
  preferences: ProviderSkillPreferences,
): ServerProvider {
  if (provider.skills.length === 0) {
    return provider;
  }

  let changed = false;
  const nextSkills: ServerProviderSkill[] = [];

  for (const skill of provider.skills) {
    const preference = getProviderSkillPreference(preferences, provider.instanceId, skill);
    if (preference?.disabled && skill.enabled) {
      changed = true;
      nextSkills.push({ ...skill, enabled: false });
      continue;
    }
    nextSkills.push(skill);
  }

  return changed ? { ...provider, skills: nextSkills } : provider;
}

export function applyProvidersSkillPreferences(
  providers: ReadonlyArray<ServerProvider>,
  preferences: ProviderSkillPreferences,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => applyProviderSkillPreferences(provider, preferences));
}

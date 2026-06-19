import { BookOpenIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ProviderInstanceId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "~/providerSkillPresentation";
import { getProviderSkillPreference, providerSkillPreferenceKey } from "~/providerSkillPreferences";
import { useSettings } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { applySettingsUpdated, useServerProviders } from "~/rpc/serverState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface OpenCodeSkillRow {
  readonly provider: ServerProvider;
  readonly skill: ServerProviderSkill;
  readonly disabled: boolean;
}

function isOpenCodeProvider(provider: ServerProvider): boolean {
  return provider.driver === "opencode";
}

function providerLabel(provider: Pick<ServerProvider, "displayName" | "instanceId">): string {
  return provider.displayName ?? provider.instanceId;
}

function skillStatusLabel(row: OpenCodeSkillRow): "Disabled" | "Enabled" {
  if (row.disabled || !row.skill.enabled) return "Disabled";
  return "Enabled";
}

function skillStatusVariant(status: ReturnType<typeof skillStatusLabel>) {
  switch (status) {
    case "Enabled":
      return "success";
    case "Disabled":
      return "warning";
  }
}

function OpenCodeSkillSettingsRow({
  row,
  onSetDisabled,
  onRemove,
  updating,
  removing,
}: {
  readonly row: OpenCodeSkillRow;
  readonly onSetDisabled: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
    disabled: boolean,
  ) => void;
  readonly onRemove: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
  ) => Promise<void>;
  readonly updating: boolean;
  readonly removing: boolean;
}) {
  const displayName = formatProviderSkillDisplayName(row.skill);
  const status = skillStatusLabel(row);
  const sourceLabel = formatProviderSkillInstallSource(row.skill);
  const rowDescription =
    row.skill.shortDescription ?? row.skill.description ?? "No skill description provided.";
  const details = [
    providerLabel(row.provider),
    sourceLabel,
    row.skill.scope ? `${row.skill.scope} scope` : null,
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{displayName}</span>
          <Badge size="sm" variant={skillStatusVariant(status)}>
            {status}
          </Badge>
        </span>
      }
      description={rowDescription}
      status={
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate">{details.join(" / ")}</span>
          <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
            {row.skill.path}
          </code>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={!row.disabled && row.skill.enabled}
            aria-label={`${displayName} skill enabled`}
            onCheckedChange={(checked) =>
              onSetDisabled(row.provider.instanceId, row.skill, !Boolean(checked))
            }
            disabled={updating || removing}
          />
          <Button
            size="xs"
            variant="outline"
            className="text-muted-foreground"
            disabled={updating || removing}
            onClick={() => void onRemove(row.provider.instanceId, row.skill)}
          >
            <Trash2Icon className="size-3.5" />
            {removing ? "Removing..." : "Remove"}
          </Button>
        </div>
      }
    />
  );
}

export function SkillsSettingsPanel() {
  const providers = useServerProviders();
  const { providerSkillPreferences } = useSettings();
  const [removingSkillKey, setRemovingSkillKey] = useState<string | null>(null);
  const [updatingSkillKey, setUpdatingSkillKey] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  const openCodeProviders = useMemo(() => providers.filter(isOpenCodeProvider), [providers]);
  const rows = useMemo<OpenCodeSkillRow[]>(() => {
    return openCodeProviders
      .flatMap((provider) =>
        provider.skills.map((skill) => {
          const preference = getProviderSkillPreference(
            providerSkillPreferences,
            provider.instanceId,
            skill,
          );
          return {
            provider,
            skill,
            disabled: Boolean(preference?.disabled),
          } satisfies OpenCodeSkillRow;
        }),
      )
      .toSorted((left, right) => {
        const leftName = formatProviderSkillDisplayName(left.skill).toLowerCase();
        const rightName = formatProviderSkillDisplayName(right.skill).toLowerCase();
        return (
          providerLabel(left.provider).localeCompare(providerLabel(right.provider)) ||
          leftName.localeCompare(rightName) ||
          providerSkillPreferenceKey(left.skill).localeCompare(
            providerSkillPreferenceKey(right.skill),
          )
        );
      });
  }, [openCodeProviders, providerSkillPreferences]);

  const disabledCount = rows.filter((row) => row.disabled || !row.skill.enabled).length;

  const setDisabled = useCallback(
    async (
      providerInstanceId: ProviderInstanceId,
      skill: ServerProviderSkill,
      disabled: boolean,
    ) => {
      const skillKey = `${providerInstanceId}:${providerSkillPreferenceKey(skill)}`;
      setUpdatingSkillKey(skillKey);
      setPreferenceError(null);
      try {
        const settings = await ensureLocalApi().server.setProviderSkillPreference({
          instanceId: providerInstanceId,
          skillPath: skill.path,
          disabled,
        });
        applySettingsUpdated(settings);
      } catch (error) {
        setPreferenceError(
          error instanceof Error ? error.message : "Failed to update skill preference.",
        );
      } finally {
        setUpdatingSkillKey((current) => (current === skillKey ? null : current));
      }
    },
    [],
  );

  const removeSkill = useCallback(
    async (providerInstanceId: ProviderInstanceId, skill: ServerProviderSkill) => {
      const displayName = formatProviderSkillDisplayName(skill);
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Remove ${displayName}? This deletes the local skill folder that contains:\n\n${skill.path}`,
      );
      if (!confirmed) {
        return;
      }

      const skillKey = `${providerInstanceId}:${providerSkillPreferenceKey(skill)}`;
      setRemovingSkillKey(skillKey);
      setRemoveError(null);
      try {
        await ensureLocalApi().server.removeProviderSkill({
          instanceId: providerInstanceId,
          skillPath: skill.path,
        });
      } catch (error) {
        setRemoveError(error instanceof Error ? error.message : "Failed to remove skill.");
      } finally {
        setRemovingSkillKey((current) => (current === skillKey ? null : current));
      }
    },
    [],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="OpenCode Skills"
        icon={<BookOpenIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{rows.length} installed</span>
            {disabledCount > 0 ? <span>{disabledCount} disabled</span> : null}
          </div>
        }
      >
        {openCodeProviders.length === 0 || rows.length === 0 ? (
          <div className="p-8">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No OpenCode skills found</EmptyTitle>
                <EmptyDescription>
                  OpenCode skills will appear here after the OpenCode provider reports them.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          rows.map((row) => (
            <OpenCodeSkillSettingsRow
              key={`${row.provider.instanceId}:${providerSkillPreferenceKey(row.skill)}`}
              row={row}
              onSetDisabled={setDisabled}
              onRemove={removeSkill}
              updating={
                updatingSkillKey ===
                `${row.provider.instanceId}:${providerSkillPreferenceKey(row.skill)}`
              }
              removing={
                removingSkillKey ===
                `${row.provider.instanceId}:${providerSkillPreferenceKey(row.skill)}`
              }
            />
          ))
        )}
      </SettingsSection>

      {preferenceError ? (
        <SettingsSection title="Preference Error">
          <SettingsRow title="Skill preference update failed" description={preferenceError} />
        </SettingsSection>
      ) : null}

      {removeError ? (
        <SettingsSection title="Removal Error">
          <SettingsRow title="Skill removal failed" description={removeError} />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Add Skills">
        <SettingsRow
          title="Install a new skill"
          description="Skill installation needs a provider write path and source validation before it is safe to expose here."
          control={
            <Button size="xs" variant="outline" disabled>
              Add skill
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

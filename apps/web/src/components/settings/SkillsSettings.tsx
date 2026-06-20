import {
  BookOpenIcon,
  CloudIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  ProviderInstanceId,
  ServerInstallProviderSkillSource,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSkillCatalog,
  ServerProviderSkillCatalogEntry,
} from "@t3tools/contracts";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "~/providerSkillPresentation";
import { getProviderSkillPreference, providerSkillPreferenceKey } from "~/providerSkillPreferences";
import { useSettings } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { applyProvidersUpdated, applySettingsUpdated, useServerProviders } from "~/rpc/serverState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface OpenCodeSkillRow {
  readonly provider: ServerProvider;
  readonly skill: ServerProviderSkill;
  readonly disabled: boolean;
}

interface CatalogSkillItem {
  readonly entry: ServerProviderSkillCatalogEntry;
  readonly installedRow: OpenCodeSkillRow | null;
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

function skillRowKey(row: OpenCodeSkillRow): string {
  return `${row.provider.instanceId}:${providerSkillPreferenceKey(row.skill)}`;
}

function formatCatalogTierLabel(tier: ServerProviderSkillCatalogEntry["tier"]): string {
  switch (tier) {
    case "core":
      return "Core";
    case "verified":
      return "Verified";
    case "experimental":
      return "Experimental";
  }
}

function buildCatalogItems(
  entries: ReadonlyArray<ServerProviderSkillCatalogEntry>,
  rows: ReadonlyArray<OpenCodeSkillRow>,
  section: ServerProviderSkillCatalogEntry["section"],
): ReadonlyArray<CatalogSkillItem> {
  const installedByName = new Map<string, OpenCodeSkillRow>();
  for (const row of rows) {
    if (!installedByName.has(row.skill.name)) {
      installedByName.set(row.skill.name, row);
    }
  }

  return entries
    .filter((entry) => entry.section === section)
    .map((entry) => ({
      entry,
      installedRow: installedByName.get(entry.name) ?? null,
    }))
    .toSorted((left, right) => left.entry.title.localeCompare(right.entry.title));
}

function mergeInstalledSkillIntoProviders(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
  skillName: string,
  skillPath: string,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => {
    if (provider.instanceId !== instanceId) {
      return provider;
    }

    const alreadyPresent = provider.skills.some(
      (skill) => skill.path === skillPath || skill.name === skillName,
    );
    if (alreadyPresent) {
      return provider;
    }

    return {
      ...provider,
      skills: [
        ...provider.skills,
        {
          name: skillName,
          path: skillPath,
          enabled: true,
          scope: "user",
        } satisfies ServerProviderSkill,
      ].toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  });
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
              onSetDisabled(row.provider.instanceId, row.skill, !checked)
            }
            disabled={updating || removing}
          />
          <Button
            size="icon-xs"
            variant="outline"
            className="text-muted-foreground"
            disabled={updating || removing}
            aria-label={`Remove ${displayName}`}
            onClick={() => void onRemove(row.provider.instanceId, row.skill)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}

function CatalogSkillSettingsRow({
  item,
  installDisabled,
  installing,
  updating,
  removing,
  onInstall,
  onSetDisabled,
  onRemove,
}: {
  readonly item: CatalogSkillItem;
  readonly installDisabled: boolean;
  readonly installing: boolean;
  readonly updating: boolean;
  readonly removing: boolean;
  readonly onInstall: (entry: ServerProviderSkillCatalogEntry) => Promise<void>;
  readonly onSetDisabled: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
    disabled: boolean,
  ) => void;
  readonly onRemove: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
  ) => Promise<void>;
}) {
  const row = item.installedRow;
  const details = [
    item.entry.category,
    formatCatalogTierLabel(item.entry.tier),
    item.entry.owner,
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{item.entry.title}</span>
          {row ? (
            <Badge size="sm" variant={skillStatusVariant(skillStatusLabel(row))}>
              {skillStatusLabel(row)}
            </Badge>
          ) : (
            <Badge size="sm" variant="outline">
              Available
            </Badge>
          )}
        </span>
      }
      description={item.entry.description}
      status={
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate">{details.join(" / ")}</span>
          {row ? (
            <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
              {row.skill.path}
            </code>
          ) : null}
        </div>
      }
      control={
        row ? (
          <div className="flex items-center gap-2">
            <Switch
              checked={!row.disabled && row.skill.enabled}
              aria-label={`${item.entry.title} skill enabled`}
              onCheckedChange={(checked) =>
                onSetDisabled(row.provider.instanceId, row.skill, !checked)
              }
              disabled={updating || removing}
            />
            <Button
              size="icon-xs"
              variant="outline"
              className="text-muted-foreground"
              disabled={updating || removing}
              aria-label={`Remove ${item.entry.title}`}
              onClick={() => void onRemove(row.provider.instanceId, row.skill)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={installDisabled || installing}
            onClick={() => void onInstall(item.entry)}
          >
            <PlusIcon className="size-3.5" />
            {installing ? "Adding..." : "Add"}
          </Button>
        )
      }
    />
  );
}

function CatalogSkillSection({
  title,
  icon,
  items,
  emptyTitle,
  emptyDescription,
  installDisabled,
  installingSkillKey,
  updatingSkillKey,
  removingSkillKey,
  onInstall,
  onSetDisabled,
  onRemove,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly items: ReadonlyArray<CatalogSkillItem>;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly installDisabled: boolean;
  readonly installingSkillKey: string | null;
  readonly updatingSkillKey: string | null;
  readonly removingSkillKey: string | null;
  readonly onInstall: (entry: ServerProviderSkillCatalogEntry) => Promise<void>;
  readonly onSetDisabled: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
    disabled: boolean,
  ) => void;
  readonly onRemove: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
  ) => Promise<void>;
}) {
  const installedCount = items.filter((item) => item.installedRow).length;

  return (
    <SettingsSection
      title={title}
      icon={icon}
      headerAction={
        <span className="text-[11px] text-muted-foreground">
          {installedCount}/{items.length} installed
        </span>
      }
    >
      {items.length === 0 ? (
        <div className="p-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CloudIcon />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>{emptyDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        items.map((item) => {
          const installedKey = item.installedRow ? skillRowKey(item.installedRow) : null;
          return (
            <CatalogSkillSettingsRow
              key={item.entry.id}
              item={item}
              installDisabled={installDisabled}
              installing={installingSkillKey === `catalog:${item.entry.id}`}
              updating={installedKey !== null && updatingSkillKey === installedKey}
              removing={installedKey !== null && removingSkillKey === installedKey}
              onInstall={onInstall}
              onSetDisabled={onSetDisabled}
              onRemove={onRemove}
            />
          );
        })
      )}
    </SettingsSection>
  );
}

export function SkillsSettingsPanel() {
  const providers = useServerProviders();
  const { providerSkillPreferences } = useSettings();
  const [catalog, setCatalog] = useState<ServerProviderSkillCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installingSkillKey, setInstallingSkillKey] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removingSkillKey, setRemovingSkillKey] = useState<string | null>(null);
  const [updatingSkillKey, setUpdatingSkillKey] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  const openCodeProviders = useMemo(() => providers.filter(isOpenCodeProvider), [providers]);
  const installProvider = openCodeProviders[0] ?? null;
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

  const catalogEntries = catalog?.entries ?? [];
  const recommendedItems = useMemo(
    () => buildCatalogItems(catalogEntries, rows, "recommended"),
    [catalogEntries, rows],
  );
  const communityItems = useMemo(
    () => buildCatalogItems(catalogEntries, rows, "community"),
    [catalogEntries, rows],
  );
  const catalogSkillNames = useMemo(
    () => new Set(catalogEntries.map((entry) => entry.name)),
    [catalogEntries],
  );
  const otherRows = useMemo(
    () => rows.filter((row) => !catalogSkillNames.has(row.skill.name)),
    [catalogSkillNames, rows],
  );
  const disabledCount = rows.filter((row) => row.disabled || !row.skill.enabled).length;
  const installedCatalogCount =
    recommendedItems.filter((item) => item.installedRow).length +
    communityItems.filter((item) => item.installedRow).length;
  const installDisabled = installProvider === null;

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const result = await ensureLocalApi().server.listProviderSkillCatalog();
      setCatalog(result.catalog);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "Failed to load skill catalog.");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const installSkill = useCallback(
    async (source: ServerInstallProviderSkillSource, key: string): Promise<boolean> => {
      if (!installProvider) {
        setInstallError("An OpenCode provider is required before installing skills.");
        return false;
      }

      setInstallingSkillKey(key);
      setInstallError(null);
      try {
        const result = await ensureLocalApi().server.installProviderSkill({
          instanceId: installProvider.instanceId,
          source,
        });
        applyProvidersUpdated({
          providers: mergeInstalledSkillIntoProviders(
            result.providers,
            installProvider.instanceId,
            result.skillName,
            result.skillPath,
          ),
        });
        return true;
      } catch (error) {
        setInstallError(error instanceof Error ? error.message : "Failed to install skill.");
        return false;
      } finally {
        setInstallingSkillKey((current) => (current === key ? null : current));
      }
    },
    [installProvider],
  );

  const installCatalogSkill = useCallback(
    async (entry: ServerProviderSkillCatalogEntry) => {
      await installSkill({ type: "catalog", catalogEntryId: entry.id }, `catalog:${entry.id}`);
    },
    [installSkill],
  );

  const installLinkedSkill = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) {
      setInstallError("Enter a skill URL first.");
      return;
    }
    const installed = await installSkill({ type: "url", url }, "url");
    if (installed) {
      setInstallUrl("");
    }
  }, [installSkill, installUrl]);

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
        const result = await ensureLocalApi().server.removeProviderSkill({
          instanceId: providerInstanceId,
          skillPath: skill.path,
        });
        applyProvidersUpdated(result);
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
      <CatalogSkillSection
        title="Recommended Skills"
        icon={<SparklesIcon className="size-3.5" />}
        items={recommendedItems}
        emptyTitle={catalogLoading ? "Loading recommended skills" : "No recommended skills"}
        emptyDescription={
          catalogLoading
            ? "The UCSD skill catalog is loading."
            : "Recommended UCSD skills will appear here when the catalog is available."
        }
        installDisabled={installDisabled}
        installingSkillKey={installingSkillKey}
        updatingSkillKey={updatingSkillKey}
        removingSkillKey={removingSkillKey}
        onInstall={installCatalogSkill}
        onSetDisabled={setDisabled}
        onRemove={removeSkill}
      />

      <CatalogSkillSection
        title="Community Skills"
        icon={<UsersIcon className="size-3.5" />}
        items={communityItems}
        emptyTitle={catalogLoading ? "Loading community skills" : "No community skills"}
        emptyDescription={
          catalogLoading
            ? "The UCSD skill catalog is loading."
            : "Community-created skills will appear here when the catalog is available."
        }
        installDisabled={installDisabled}
        installingSkillKey={installingSkillKey}
        updatingSkillKey={updatingSkillKey}
        removingSkillKey={removingSkillKey}
        onInstall={installCatalogSkill}
        onSetDisabled={setDisabled}
        onRemove={removeSkill}
      />

      <SettingsSection
        title="Add From Link"
        icon={<LinkIcon className="size-3.5" />}
        headerAction={
          catalog ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh skill catalog"
              disabled={catalogLoading}
              onClick={() => void loadCatalog()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Skill source URL"
          description="Install a GitHub skill folder, a GitHub SKILL.md file, or a hosted skill bundle."
        >
          <form
            className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void installLinkedSkill();
            }}
          >
            <Input
              nativeInput
              value={installUrl}
              placeholder="https://github.com/ucsd/.../tree/main/skill"
              aria-label="Skill source URL"
              disabled={installingSkillKey === "url"}
              onChange={(event) => setInstallUrl(event.currentTarget.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={installDisabled || installingSkillKey === "url"}
              className="sm:w-24"
            >
              <PlusIcon className="size-3.5" />
              {installingSkillKey === "url" ? "Adding..." : "Add"}
            </Button>
          </form>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Other OpenCode Skills"
        icon={<BookOpenIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{rows.length} installed</span>
            {installedCatalogCount > 0 ? <span>{installedCatalogCount} catalog</span> : null}
            {disabledCount > 0 ? <span>{disabledCount} disabled</span> : null}
          </div>
        }
      >
        {openCodeProviders.length === 0 ? (
          <div className="p-8">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No OpenCode provider found</EmptyTitle>
                <EmptyDescription>
                  OpenCode needs to be available before skills can be installed.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : otherRows.length === 0 ? (
          <div className="p-8">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No other skills</EmptyTitle>
                <EmptyDescription>
                  Skills from the UCSD catalog stay in Recommended or Community.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          otherRows.map((row) => (
            <OpenCodeSkillSettingsRow
              key={skillRowKey(row)}
              row={row}
              onSetDisabled={setDisabled}
              onRemove={removeSkill}
              updating={updatingSkillKey === skillRowKey(row)}
              removing={removingSkillKey === skillRowKey(row)}
            />
          ))
        )}
      </SettingsSection>

      {catalogError ? (
        <SettingsSection title="Catalog Error">
          <SettingsRow title="Skill catalog failed to load" description={catalogError} />
        </SettingsSection>
      ) : null}

      {installError ? (
        <SettingsSection title="Install Error">
          <SettingsRow title="Skill installation failed" description={installError} />
        </SettingsSection>
      ) : null}

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
    </SettingsPageContainer>
  );
}

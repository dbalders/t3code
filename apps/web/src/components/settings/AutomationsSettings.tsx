import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_PROVIDER_DRIVER_KIND,
  DEFAULT_PROVIDER_INSTANCE_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  getDefaultModelForProvider,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScheduledTask,
  type ScheduledTaskRRuleConfig,
  type ScheduledTaskRun,
  type ScheduledTaskUpdateInput,
  type ScheduledTaskWeekday,
  type ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useRouter } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  Clock3Icon,
  FolderIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "~/composerDraftStore";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useSettings } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { cn, newDraftId, newThreadId } from "~/lib/utils";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  type AppModelOption,
} from "~/modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { applyProvidersSkillPreferences } from "~/providerSkillPreferences";
import { filterVisibleServerProviders } from "~/providerVisibility";
import { useServerProviders } from "~/rpc/serverState";
import { selectProjectsForEnvironment, selectThreadsForEnvironment, useStore } from "~/store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Dialog, DialogPanel, DialogPopup } from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { getComposerProviderState } from "../chat/composerProviderState";
import { SettingsPageContainer } from "./settingsLayout";

type Cadence = "once" | ScheduledTaskRRuleConfig["frequency"];

const WEEKDAYS: ReadonlyArray<{ value: ScheduledTaskWeekday; label: string }> = [
  { value: "MO", label: "Mon" },
  { value: "TU", label: "Tue" },
  { value: "WE", label: "Wed" },
  { value: "TH", label: "Thu" },
  { value: "FR", label: "Fri" },
  { value: "SA", label: "Sat" },
  { value: "SU", label: "Sun" },
];

const WEEKDAY_SET = "MO,TU,WE,TH,FR";

const KIND_LABELS: Record<ScheduledTask["kind"], string> = {
  standalone: "New thread",
  thread: "Existing thread",
};

const CADENCE_LABELS: Record<Cadence, string> = {
  daily: "Daily",
  monthly: "Monthly",
  once: "Once",
  weekly: "Weekly",
};

const CREATE_VIA_CHAT_PROMPT =
  "I want to set up an automation. Briefly explain how automations work in T3Code, then ask me a few questions to figure out what I'd like T3Code to do and when it should run.";

interface AutomationFormState {
  readonly name: string;
  readonly kind: ScheduledTask["kind"];
  readonly projectId: string;
  readonly targetThreadId: string;
  readonly cadence: Cadence;
  readonly startAt: string;
  readonly interval: string;
  readonly weekdays: ReadonlyArray<ScheduledTaskWeekday>;
  readonly monthDay: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly catchUp: boolean;
  readonly modelSelection: ModelSelection | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDatetimeLocalInputValue(date: Date): string {
  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    "T",
    pad2(date.getHours()),
    ":",
    pad2(date.getMinutes()),
  ].join("");
}

function defaultStartAt(): string {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return toDatetimeLocalInputValue(date);
}

function initialFormState(timezone: string): AutomationFormState {
  const now = new Date();
  return {
    name: "",
    kind: "standalone",
    projectId: "",
    targetThreadId: "",
    cadence: "daily",
    startAt: defaultStartAt(),
    interval: "1",
    weekdays: ["MO", "TU", "WE", "TH", "FR"],
    monthDay: String(now.getDate()),
    timezone,
    prompt: "",
    catchUp: false,
    modelSelection: null,
  };
}

function isAutomationKind(value: unknown): value is ScheduledTask["kind"] {
  return value === "thread" || value === "standalone";
}

function isCadence(value: unknown): value is Cadence {
  return value === "once" || value === "daily" || value === "weekly" || value === "monthly";
}

function createFallbackModelSelection(): ModelSelection {
  return {
    instanceId: DEFAULT_PROVIDER_INSTANCE_ID,
    model: getDefaultModelForProvider(DEFAULT_PROVIDER_DRIVER_KIND),
  };
}

function fallbackModelSelectionFromEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ModelSelection {
  const entry = entries.find((candidate) => candidate.enabled && candidate.isAvailable);
  if (!entry) return createFallbackModelSelection();
  return {
    instanceId: entry.instanceId,
    model:
      entry.models.find((model) => !model.isCustom)?.slug ??
      entry.models[0]?.slug ??
      getDefaultModelForProvider(entry.driverKind),
  };
}

function resolveModelSelectionForEntries(input: {
  readonly selection: ModelSelection | null | undefined;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ReturnType<typeof useServerProviders>[number]>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly prompt: string;
}): ModelSelection {
  const { selection, settings, providers, entries, prompt } = input;
  const fallbackSelection = fallbackModelSelectionFromEntries(entries);
  const selectedEntry =
    entries.find(
      (entry) => entry.instanceId === selection?.instanceId && entry.enabled && entry.isAvailable,
    ) ??
    entries.find((entry) => entry.instanceId === fallbackSelection.instanceId) ??
    entries.find((entry) => entry.enabled && entry.isAvailable);
  if (!selectedEntry) return fallbackSelection;
  const model =
    resolveAppModelSelectionForInstance(
      selectedEntry.instanceId,
      settings,
      providers,
      selection?.instanceId === selectedEntry.instanceId ? selection.model : null,
    ) ??
    selectedEntry.models[0]?.slug ??
    getDefaultModelForProvider(selectedEntry.driverKind);
  const currentOptions =
    selection?.instanceId === selectedEntry.instanceId ? selection.options : undefined;
  const providerState = getComposerProviderState({
    provider: selectedEntry.driverKind,
    model,
    models: selectedEntry.models,
    prompt,
    modelOptions: currentOptions,
  });
  return createModelSelection(
    selectedEntry.instanceId,
    model,
    providerState.modelOptionsForDispatch,
  );
}

function preferredModelSelectionForTarget(input: {
  readonly explicit: ModelSelection | null | undefined;
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ReturnType<typeof useServerProviders>[number]>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly prompt: string;
}): ModelSelection {
  return resolveModelSelectionForEntries({
    selection: input.explicit ?? input.threadModelSelection ?? input.projectModelSelection ?? null,
    settings: input.settings,
    providers: input.providers,
    entries: input.entries,
    prompt: input.prompt,
  });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

function parseDatetimeLocalInputValue(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? "" : " from now";
  const units: ReadonlyArray<[number, string]> = [
    [24 * 60 * 60 * 1_000, "d"],
    [60 * 60 * 1_000, "h"],
    [60 * 1_000, "m"],
  ];
  for (const [unitMs, label] of units) {
    if (absMs >= unitMs) {
      return `${Math.max(1, Math.round(absMs / unitMs))}${label}${suffix}`;
    }
  }
  return diffMs >= 0 ? "now" : "soon";
}

function parseRRuleConfig(task: ScheduledTask): ScheduledTaskRRuleConfig | null {
  if (task.scheduleKind !== "rrule") return null;
  try {
    return JSON.parse(task.scheduleValue) as ScheduledTaskRRuleConfig;
  } catch {
    return null;
  }
}

function formatSchedule(task: ScheduledTask): string {
  if (task.scheduleKind === "once") return `Once at ${formatDateTime(task.scheduleValue)}`;
  const config = parseRRuleConfig(task);
  if (!config) return "Custom schedule";
  const time = formatTime(config.dtStart);
  const interval = config.interval === 1 ? "" : ` every ${config.interval}`;
  if (config.frequency === "daily") return `Daily${time ? ` at ${time}` : ""}`;
  if (config.frequency === "weekly") {
    const days = config.byDay?.join(",") ?? "";
    const label = days === WEEKDAY_SET ? "Weekdays" : `Weekly${interval}`;
    return `${label}${time ? ` at ${time}` : ""}`;
  }
  if (config.frequency === "monthly" && config.byMonthDay?.length) {
    return `Monthly on day ${config.byMonthDay.join(", ")}${time ? ` at ${time}` : ""}`;
  }
  return `${config.frequency[0]?.toUpperCase()}${config.frequency.slice(1)}${interval}`;
}

function statusVariant(status: ScheduledTask["status"]) {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "deleted":
      return "outline";
  }
}

function buildSchedule(form: AutomationFormState): {
  readonly scheduleKind: ScheduledTask["scheduleKind"];
  readonly scheduleValue: string;
} {
  const startAtDate = new Date(form.startAt);
  if (Number.isNaN(startAtDate.getTime())) {
    throw new Error("Choose a valid start time.");
  }
  const startAtIso = startAtDate.toISOString();
  if (form.cadence === "once") {
    return {
      scheduleKind: "once",
      scheduleValue: startAtIso,
    };
  }
  const interval = Math.max(1, Number.parseInt(form.interval, 10) || 1);
  const config: ScheduledTaskRRuleConfig = {
    frequency: form.cadence,
    interval,
    dtStart: startAtIso,
    ...(form.cadence === "weekly" ? { byDay: form.weekdays.length ? form.weekdays : ["MO"] } : {}),
    ...(form.cadence === "monthly"
      ? { byMonthDay: [Math.min(31, Math.max(1, Number.parseInt(form.monthDay, 10) || 1))] }
      : {}),
  };
  return {
    scheduleKind: "rrule",
    scheduleValue: JSON.stringify(config),
  };
}

function formStateFromTask(task: ScheduledTask): AutomationFormState {
  const config = parseRRuleConfig(task);
  const cadence: Cadence = task.scheduleKind === "once" ? "once" : (config?.frequency ?? "daily");
  const startAtIso = task.scheduleKind === "once" ? task.scheduleValue : config?.dtStart;
  const startAtDate = startAtIso ? new Date(startAtIso) : new Date();
  const fallbackStartAt = Number.isNaN(startAtDate.getTime())
    ? defaultStartAt()
    : toDatetimeLocalInputValue(startAtDate);
  const monthDay =
    config?.byMonthDay?.[0] ??
    (Number.isNaN(startAtDate.getTime()) ? new Date().getDate() : startAtDate.getDate());

  return {
    name: task.name,
    kind: task.kind,
    projectId: task.projectId,
    targetThreadId: task.targetThreadId ?? "",
    cadence,
    startAt: fallbackStartAt,
    interval: String(config?.interval ?? 1),
    weekdays: config?.byDay ?? ["MO", "TU", "WE", "TH", "FR"],
    monthDay: String(monthDay),
    timezone: task.timezone,
    prompt: task.prompt,
    catchUp: task.catchUp,
    modelSelection: task.modelSelection,
  };
}

function AutomationField({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function AutomationErrorBanner({ message }: { readonly message: string }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-foreground">
      {message}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  variant = "ghost",
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly variant?: "ghost" | "outline" | "destructive-outline";
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
            size="icon-sm"
            variant={variant}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function AutomationModelControls({
  selection,
  providerEntries,
  modelOptionsByInstance,
  settings,
  providers,
  prompt,
  disabled,
  className,
  onPromptChange,
  onSelectionChange,
}: {
  readonly selection: ModelSelection | null | undefined;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ReturnType<typeof useServerProviders>[number]>;
  readonly prompt: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSelectionChange: (selection: ModelSelection) => void;
}) {
  const entries = providerEntries.filter((entry) => entry.enabled && entry.isAvailable);
  const currentSelection = resolveModelSelectionForEntries({
    selection,
    settings,
    providers,
    entries,
    prompt,
  });
  const currentEntry =
    entries.find((entry) => entry.instanceId === currentSelection.instanceId) ?? entries[0];

  if (!currentEntry) {
    return (
      <Button disabled size="sm" variant="ghost" className={cn("justify-start", className)}>
        Model unavailable
      </Button>
    );
  }

  const updateSelection = (
    entry: ProviderInstanceEntry,
    model: string,
    options: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => {
    const providerState = getComposerProviderState({
      provider: entry.driverKind,
      model,
      models: entry.models,
      prompt,
      modelOptions: options,
    });
    onSelectionChange(
      createModelSelection(entry.instanceId, model, providerState.modelOptionsForDispatch),
    );
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <ProviderModelPicker
        activeInstanceId={currentSelection.instanceId}
        compact
        disabled={disabled ?? false}
        instanceEntries={entries}
        lockedProvider={null}
        model={currentSelection.model}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerVariant="ghost"
        triggerClassName="max-w-52 px-2"
        onInstanceModelChange={(instanceId, model) => {
          const entry = entries.find((candidate) => candidate.instanceId === instanceId);
          if (!entry) return;
          const options =
            instanceId === currentSelection.instanceId ? currentSelection.options : undefined;
          updateSelection(entry, model, options);
        }}
      />
      <TraitsPicker
        allowPromptInjectedEffort={false}
        instanceId={currentEntry.instanceId}
        model={currentSelection.model}
        modelOptions={currentSelection.options}
        models={currentEntry.models}
        prompt={prompt}
        provider={currentEntry.driverKind}
        triggerVariant="ghost"
        triggerClassName="max-w-40 px-2"
        onModelOptionsChange={(nextOptions) => {
          updateSelection(currentEntry, currentSelection.model, nextOptions);
        }}
        onPromptChange={onPromptChange}
      />
    </div>
  );
}

function AutomationRow({
  task,
  projectName,
  threadTitle,
  selected,
  busy,
  onSelect,
  onEdit,
  onRun,
  onPauseResume,
  onDelete,
}: {
  readonly task: ScheduledTask;
  readonly projectName: string;
  readonly threadTitle: string | null;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
  readonly onRun: () => void;
  readonly onPauseResume: () => void;
  readonly onDelete: () => void;
}) {
  const active = task.status === "active";
  return (
    <div
      aria-pressed={selected}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      className={cn(
        "group grid w-full min-w-0 grid-cols-[1rem_1fr_auto] items-center gap-4 rounded-xl px-3 py-3 text-left transition-colors",
        "hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          active ? "bg-info" : task.status === "paused" ? "bg-muted-foreground/55" : "bg-border",
        )}
      />
      <span className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-foreground">
            {task.name}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {projectName}
            {task.kind === "thread" && threadTitle ? ` - ${threadTitle}` : ""}
          </span>
        </span>
      </span>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="hidden min-w-32 justify-end sm:flex">{formatSchedule(task)}</span>
        <span className="hidden items-center gap-1 opacity-0 transition-opacity group-hover:flex group-focus-within:flex group-focus-visible:flex sm:flex group-hover:opacity-100 group-focus-within:opacity-100 group-focus-visible:opacity-100">
          <IconButton disabled={busy} label="Run now" onClick={onRun}>
            <PlayIcon className="size-4" />
          </IconButton>
          <IconButton label="Edit" onClick={onEdit}>
            <SquarePenIcon className="size-4" />
          </IconButton>
          <IconButton disabled={busy} label={active ? "Pause" : "Resume"} onClick={onPauseResume}>
            {active ? (
              <CirclePauseIcon className="size-4" />
            ) : (
              <CirclePlayIcon className="size-4" />
            )}
          </IconButton>
          <IconButton disabled={busy} label="Delete" onClick={onDelete}>
            <Trash2Icon className="size-4" />
          </IconButton>
        </span>
      </span>
    </div>
  );
}

function AutomationListSection({
  title,
  tasks,
  selectedTaskId,
  projectById,
  threadById,
  mutatingTaskId,
  onSelect,
  onMutate,
  onDelete,
}: {
  readonly title: string;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly selectedTaskId: string | null;
  readonly projectById: Map<ProjectId, { readonly name: string }>;
  readonly threadById: Map<ThreadId, { readonly title: string }>;
  readonly mutatingTaskId: string | null;
  readonly onSelect: (task: ScheduledTask) => void;
  readonly onMutate: (task: ScheduledTask, action: "pause" | "resume" | "run") => void;
  readonly onDelete: (task: ScheduledTask) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between border-b border-border/70 px-4 pb-3">
        <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
      </div>
      <div className="space-y-1">
        {tasks.map((task) => {
          const project = projectById.get(task.projectId);
          const thread = task.targetThreadId ? threadById.get(task.targetThreadId) : null;
          const busy = mutatingTaskId?.startsWith(`${task.id}:`) ?? false;
          return (
            <AutomationRow
              key={task.id}
              task={task}
              projectName={project?.name ?? String(task.projectId)}
              threadTitle={thread?.title ?? null}
              selected={selectedTaskId === task.id}
              busy={busy}
              onSelect={() => onSelect(task)}
              onEdit={() => onSelect(task)}
              onRun={() => onMutate(task, "run")}
              onPauseResume={() => onMutate(task, task.status === "active" ? "pause" : "resume")}
              onDelete={() => onDelete(task)}
            />
          );
        })}
      </div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 justify-self-end text-right text-foreground">{children ?? value}</div>
    </div>
  );
}

function AutomationDetail({
  task,
  runs,
  projects,
  threads,
  preferredSelection,
  providerEntries,
  modelOptionsByInstance,
  settings,
  providers,
  busy,
  onBack,
  onMutate,
  onDelete,
  onUpdate,
}: {
  readonly task: ScheduledTask;
  readonly runs: ReadonlyArray<ScheduledTaskRun>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title: string;
    readonly projectId: ProjectId;
  }>;
  readonly preferredSelection: ModelSelection;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ReturnType<typeof useServerProviders>[number]>;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onMutate: (task: ScheduledTask, action: "pause" | "resume" | "run") => void;
  readonly onDelete: (task: ScheduledTask) => void;
  readonly onUpdate: (task: ScheduledTask, patch: ScheduledTaskUpdateInput["patch"]) => void;
}) {
  const active = task.status === "active";
  const [nameDraftState, setNameDraftState] = useState(() => ({
    taskId: task.id,
    value: task.name,
  }));
  const [promptDraftState, setPromptDraftState] = useState(() => ({
    taskId: task.id,
    value: task.prompt,
  }));
  const [scheduleDraft, setScheduleDraft] = useState(() => formStateFromTask(task));
  const scheduleDraftRef = useRef(scheduleDraft);
  const nameDraft = nameDraftState.taskId === task.id ? nameDraftState.value : task.name;
  const promptDraft = promptDraftState.taskId === task.id ? promptDraftState.value : task.prompt;
  const projectName =
    projects.find((project) => project.id === task.projectId)?.name ?? String(task.projectId);
  const projectThreads = useMemo(
    () => threads.filter((thread) => thread.projectId === task.projectId),
    [task.projectId, threads],
  );
  const threadTitle = task.targetThreadId
    ? (threads.find((thread) => thread.id === task.targetThreadId)?.title ?? null)
    : null;

  useEffect(() => {
    setNameDraftState({ taskId: task.id, value: task.name });
    setPromptDraftState({ taskId: task.id, value: task.prompt });
  }, [task.id]);

  useEffect(() => {
    const nextScheduleDraft = formStateFromTask(task);
    setScheduleDraft(nextScheduleDraft);
    scheduleDraftRef.current = nextScheduleDraft;
  }, [task.catchUp, task.id, task.scheduleKind, task.scheduleValue, task.timezone]);

  const saveNameDraft = useCallback(
    (taskId: ScheduledTask["id"], value: string) => {
      if (taskId !== task.id) return;
      const name = value.trim();
      if (!name || name === task.name) return;
      onUpdate(task, { name });
    },
    [onUpdate, task],
  );

  const savePromptDraft = useCallback(
    (taskId: ScheduledTask["id"], value: string) => {
      if (taskId !== task.id) return;
      const prompt = value.trim();
      if (!prompt || prompt === task.prompt) return;
      onUpdate(task, { prompt });
    },
    [onUpdate, task],
  );

  useEffect(() => {
    if (nameDraftState.taskId !== task.id) return;
    const handle = window.setTimeout(() => {
      saveNameDraft(nameDraftState.taskId, nameDraftState.value);
    }, 600);
    return () => window.clearTimeout(handle);
  }, [nameDraftState, saveNameDraft, task.id]);

  useEffect(() => {
    if (promptDraftState.taskId !== task.id) return;
    const handle = window.setTimeout(() => {
      savePromptDraft(promptDraftState.taskId, promptDraftState.value);
    }, 600);
    return () => window.clearTimeout(handle);
  }, [promptDraftState, savePromptDraft, task.id]);

  const saveScheduleDraft = useCallback(
    (next: AutomationFormState) => {
      try {
        onUpdate(task, {
          ...buildSchedule(next),
          timezone: next.timezone.trim() || task.timezone,
          catchUp: next.catchUp,
        });
      } catch {
        return;
      }
    },
    [onUpdate, task],
  );

  const updateScheduleDraft = useCallback(
    (updater: (current: AutomationFormState) => AutomationFormState) => {
      const next = updater(scheduleDraftRef.current);
      scheduleDraftRef.current = next;
      setScheduleDraft(next);
      saveScheduleDraft(next);
    },
    [saveScheduleDraft],
  );

  const updateKind = useCallback(
    (kind: ScheduledTask["kind"]) => {
      if (kind === "standalone") {
        onUpdate(task, { kind, targetThreadId: null });
        return;
      }
      const targetThreadId = task.targetThreadId ?? projectThreads[0]?.id;
      if (!targetThreadId) return;
      onUpdate(task, { kind, targetThreadId });
    },
    [onUpdate, projectThreads, task],
  );

  const updateProject = useCallback(
    (projectId: ProjectId) => {
      if (task.kind !== "thread") {
        onUpdate(task, { projectId });
        return;
      }
      const projectThread =
        threads.find(
          (thread) => thread.projectId === projectId && thread.id === task.targetThreadId,
        ) ?? threads.find((thread) => thread.projectId === projectId);
      if (projectThread) {
        onUpdate(task, { projectId, targetThreadId: projectThread.id });
        return;
      }
      onUpdate(task, { kind: "standalone", projectId, targetThreadId: null });
    },
    [onUpdate, task, threads],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border/70 px-1 pb-5">
        <button
          type="button"
          onClick={onBack}
          className="flex min-w-0 cursor-pointer items-center gap-3 text-left text-muted-foreground hover:text-foreground"
        >
          <span>Automations</span>
          <ChevronRightIcon className="size-4" />
          <span className="truncate text-foreground">{nameDraft || task.name}</span>
        </button>
        <div className="flex items-center gap-1">
          <IconButton
            disabled={busy}
            label={active ? "Pause" : "Resume"}
            onClick={() => onMutate(task, active ? "pause" : "resume")}
          >
            {active ? (
              <CirclePauseIcon className="size-4" />
            ) : (
              <CirclePlayIcon className="size-4" />
            )}
          </IconButton>
          <IconButton disabled={busy} label="Delete" onClick={() => onDelete(task)}>
            <Trash2Icon className="size-4" />
          </IconButton>
          <Button disabled={busy} onClick={() => onMutate(task, "run")} size="sm">
            <PlayIcon className="size-4" />
            Run now
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-8 pt-8 lg:grid-cols-[minmax(0,1fr)_27rem]">
        <div className="min-w-0 space-y-8">
          <div className="space-y-6">
            <input
              aria-label="Automation title"
              value={nameDraft}
              onBlur={() => saveNameDraft(task.id, nameDraft)}
              onChange={(event) =>
                setNameDraftState({ taskId: task.id, value: event.currentTarget.value })
              }
              className="w-full max-w-4xl rounded-md bg-transparent px-0 py-1 text-4xl font-semibold tracking-[-0.04em] text-foreground outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
            />
            <textarea
              aria-label="Automation prompt"
              value={promptDraft}
              onBlur={() => savePromptDraft(task.id, promptDraft)}
              onChange={(event) =>
                setPromptDraftState({ taskId: task.id, value: event.currentTarget.value })
              }
              className="min-h-72 w-full max-w-3xl resize-y rounded-md bg-transparent px-0 py-1 text-lg leading-8 text-foreground/90 outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        <aside className="border-border/70 lg:border-l lg:pl-8">
          <div className="space-y-8">
            <section className="space-y-3">
              <h2 className="text-base text-muted-foreground">Status</h2>
              <DetailRow label="Status">
                <Badge size="lg" variant={statusVariant(task.status)}>
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      task.status === "active" ? "bg-success-foreground" : "bg-muted-foreground",
                    )}
                  />
                  {task.status === "active" ? "Active" : task.status}
                </Badge>
              </DetailRow>
              <DetailRow label="Next run" value={formatDateTime(task.nextRunAt)} />
              <DetailRow label="Last ran" value={formatDateTime(task.lastRunAt)} />
            </section>

            <section className="space-y-3">
              <h2 className="text-base text-muted-foreground">Details</h2>
              <DetailRow label="Runs in">
                <Select
                  value={task.kind}
                  onValueChange={(value) => {
                    if (!isAutomationKind(value)) return;
                    updateKind(value);
                  }}
                >
                  <SelectTrigger
                    aria-label="Runs in"
                    className="w-auto min-w-0 justify-end"
                    size="sm"
                    variant="ghost"
                  >
                    {KIND_LABELS[task.kind]}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standalone">New thread</SelectItem>
                    <SelectItem value="thread" disabled={projectThreads.length === 0}>
                      Existing thread
                    </SelectItem>
                  </SelectContent>
                </Select>
              </DetailRow>
              <DetailRow label="Project">
                <Select
                  value={task.projectId}
                  onValueChange={(value) => updateProject(value as ProjectId)}
                >
                  <SelectTrigger
                    aria-label="Project"
                    className="w-auto min-w-0 max-w-60 justify-end"
                    size="sm"
                    variant="ghost"
                  >
                    <span className="truncate">{projectName}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </DetailRow>
              {task.kind === "thread" ? (
                <DetailRow label="Thread">
                  <Select
                    value={task.targetThreadId ?? ""}
                    onValueChange={(value) => {
                      if (!value) return;
                      onUpdate(task, { targetThreadId: value as ThreadId });
                    }}
                  >
                    <SelectTrigger
                      aria-label="Thread"
                      className="w-auto min-w-0 max-w-60 justify-end"
                      size="sm"
                      variant="ghost"
                    >
                      <span className="truncate">{threadTitle ?? "Select thread"}</span>
                    </SelectTrigger>
                    <SelectContent>
                      {projectThreads.map((thread) => (
                        <SelectItem key={thread.id} value={thread.id}>
                          {thread.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </DetailRow>
              ) : null}
              <DetailRow label="Repeats">
                <Select
                  value={scheduleDraft.cadence}
                  onValueChange={(value) => {
                    if (!isCadence(value)) return;
                    updateScheduleDraft((current) => ({ ...current, cadence: value }));
                  }}
                >
                  <SelectTrigger
                    aria-label="Repeats"
                    className="w-auto min-w-0 justify-end"
                    size="sm"
                    variant="ghost"
                  >
                    {CADENCE_LABELS[scheduleDraft.cadence]}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="once">Once</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </DetailRow>
              <DetailRow label={scheduleDraft.cadence === "once" ? "Run at" : "Starts"}>
                <Input
                  aria-label={scheduleDraft.cadence === "once" ? "Run at" : "Starts"}
                  className="max-w-56 text-right"
                  type="datetime-local"
                  value={scheduleDraft.startAt}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    updateScheduleDraft((current) => ({ ...current, startAt: value }));
                  }}
                />
              </DetailRow>
              {scheduleDraft.cadence !== "once" ? (
                <DetailRow label="Interval">
                  <Input
                    aria-label="Interval"
                    className="max-w-24 text-right"
                    min={1}
                    type="number"
                    value={scheduleDraft.interval}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      updateScheduleDraft((current) => ({ ...current, interval: value }));
                    }}
                  />
                </DetailRow>
              ) : null}
              {scheduleDraft.cadence === "monthly" ? (
                <DetailRow label="Day">
                  <Input
                    aria-label="Day of month"
                    className="max-w-24 text-right"
                    max={31}
                    min={1}
                    type="number"
                    value={scheduleDraft.monthDay}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      updateScheduleDraft((current) => ({ ...current, monthDay: value }));
                    }}
                  />
                </DetailRow>
              ) : null}
              {scheduleDraft.cadence === "weekly" ? (
                <DetailRow label="Days">
                  <div className="flex max-w-60 flex-wrap justify-end gap-1.5">
                    {WEEKDAYS.map((weekday) => (
                      <label
                        key={weekday.value}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2 text-xs"
                      >
                        <Checkbox
                          checked={scheduleDraft.weekdays.includes(weekday.value)}
                          onCheckedChange={(checked) => {
                            updateScheduleDraft((current) => ({
                              ...current,
                              weekdays: checked
                                ? [...current.weekdays, weekday.value]
                                : current.weekdays.filter((day) => day !== weekday.value),
                            }));
                          }}
                        />
                        {weekday.label}
                      </label>
                    ))}
                  </div>
                </DetailRow>
              ) : null}
              <DetailRow label="Timezone">
                <Input
                  aria-label="Timezone"
                  className="max-w-56 text-right"
                  value={scheduleDraft.timezone}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    updateScheduleDraft((current) => ({ ...current, timezone: value }));
                  }}
                />
              </DetailRow>
              <DetailRow label="Catch up">
                <Switch
                  aria-label="Catch up missed runs"
                  checked={scheduleDraft.catchUp}
                  onCheckedChange={(checked) => {
                    updateScheduleDraft((current) => ({ ...current, catchUp: Boolean(checked) }));
                  }}
                />
              </DetailRow>
              <DetailRow label="Model">
                <AutomationModelControls
                  className="justify-end"
                  disabled={busy}
                  modelOptionsByInstance={modelOptionsByInstance}
                  providerEntries={providerEntries}
                  providers={providers}
                  prompt={promptDraft}
                  selection={preferredSelection}
                  settings={settings}
                  onPromptChange={(prompt) => {
                    setPromptDraftState({ taskId: task.id, value: prompt });
                    savePromptDraft(task.id, prompt);
                  }}
                  onSelectionChange={(modelSelection) => onUpdate(task, { modelSelection })}
                />
              </DetailRow>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base text-muted-foreground">Previous runs</h2>
                <MoreHorizontalIcon className="size-4 text-muted-foreground" />
              </div>
              {runs.length === 0 ? (
                <div className="py-3 text-sm text-muted-foreground">No runs yet.</div>
              ) : (
                <div className="space-y-1">
                  {runs.slice(0, 12).map((run) => (
                    <div
                      key={run.id}
                      className="grid grid-cols-[1rem_minmax(0,1fr)_3.5rem] items-center gap-3 py-2 text-sm"
                    >
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          run.status === "success"
                            ? "bg-info"
                            : run.status === "failure"
                              ? "bg-destructive"
                              : "bg-muted-foreground/55",
                        )}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-foreground">{nameDraft || task.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {run.error ?? run.resultSummary ?? run.status}
                        </div>
                      </div>
                      <span className="text-right text-muted-foreground">
                        {formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}

function AutomationCreateDialog({
  open,
  form,
  projects,
  projectThreads,
  projectName,
  threadTitle,
  saving,
  error,
  effectiveModelSelection,
  providerEntries,
  modelOptionsByInstance,
  settings,
  providers,
  onOpenChange,
  onFormChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly form: AutomationFormState;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly projectThreads: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
  readonly projectName: string | undefined;
  readonly threadTitle: string | undefined;
  readonly saving: boolean;
  readonly error: string | null;
  readonly effectiveModelSelection: ModelSelection;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ReturnType<typeof useServerProviders>[number]>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFormChange: (updater: (current: AutomationFormState) => AutomationFormState) => void;
  readonly onSubmit: () => void;
}) {
  const scheduleTimeLabel = formatTime(parseDatetimeLocalInputValue(form.startAt)) || "time";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="max-h-[min(44rem,calc(100vh-3rem))] max-w-5xl rounded-3xl border-border/70 p-0 shadow-2xl/15"
      >
        <DialogPanel scrollFade={false} className="flex min-h-[34rem] flex-col p-0">
          <div className="flex items-center justify-end gap-3 px-6 pt-6">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button aria-label="Automation info" size="icon-sm" variant="ghost">
                    <InfoIcon className="size-4" />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">Scheduled prompts run from this app.</TooltipPopup>
            </Tooltip>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onFormChange((current) => ({
                  ...current,
                  name: current.name || "Daily project check",
                  prompt:
                    current.prompt ||
                    "Review this project, summarize what changed, and call out anything that needs attention.",
                }));
              }}
            >
              Use template
            </Button>
            <Button
              aria-label="Close"
              size="icon-sm"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
            <Input
              aria-label="Automation title"
              placeholder="Automation title"
              value={form.name}
              onChange={(event) => {
                const { value } = event.currentTarget;
                onFormChange((current) => ({ ...current, name: value }));
              }}
              className="h-14 border-0 bg-transparent px-0 text-3xl shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-0"
            />
            <Textarea
              aria-label="Automation prompt"
              placeholder="Add prompt e.g. look for crashes in $sentry"
              value={form.prompt}
              onChange={(event) => {
                const { value } = event.currentTarget;
                onFormChange((current) => ({ ...current, prompt: value }));
              }}
              className="min-h-72 resize-none border-0 bg-transparent px-0 py-4 text-lg leading-8 shadow-none placeholder:text-muted-foreground/45 focus-visible:ring-0"
            />

            {error ? <AutomationErrorBanner message={error} /> : null}

            <div className="mt-auto flex flex-col gap-3 border-t border-border/60 pt-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select
                  value={form.kind}
                  onValueChange={(value) => {
                    if (!isAutomationKind(value)) return;
                    onFormChange((current) => ({ ...current, kind: value }));
                  }}
                >
                  <SelectTrigger
                    variant="ghost"
                    size="sm"
                    aria-label="Run mode"
                    className="w-auto min-w-0"
                  >
                    <span className="flex items-center gap-2">
                      <Clock3Icon className="size-4" />
                      {KIND_LABELS[form.kind]}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standalone">New thread</SelectItem>
                    <SelectItem value="thread">Existing thread</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={form.projectId}
                  onValueChange={(value) => {
                    if (!value) return;
                    onFormChange((current) => ({
                      ...current,
                      projectId: value,
                      targetThreadId: "",
                    }));
                  }}
                >
                  <SelectTrigger
                    variant="ghost"
                    size="sm"
                    aria-label="Project"
                    className="w-auto min-w-0 max-w-56"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="truncate">{projectName ?? "Select project"}</span>
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {form.kind === "thread" ? (
                  <Select
                    value={form.targetThreadId}
                    onValueChange={(value) => {
                      if (!value) return;
                      onFormChange((current) => ({ ...current, targetThreadId: value }));
                    }}
                  >
                    <SelectTrigger
                      variant="ghost"
                      size="sm"
                      aria-label="Thread"
                      className="w-auto min-w-0 max-w-56"
                    >
                      <span className="truncate">{threadTitle ?? "Select thread"}</span>
                    </SelectTrigger>
                    <SelectContent>
                      {projectThreads.map((thread) => (
                        <SelectItem key={thread.id} value={thread.id}>
                          {thread.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <Select
                  value={form.cadence}
                  onValueChange={(value) => {
                    if (!isCadence(value)) return;
                    onFormChange((current) => ({ ...current, cadence: value }));
                  }}
                >
                  <SelectTrigger
                    variant="ghost"
                    size="sm"
                    aria-label="Schedule"
                    className="w-auto min-w-0"
                  >
                    <span>
                      {CADENCE_LABELS[form.cadence]} at {scheduleTimeLabel}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="once">Once</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>

                <AutomationModelControls
                  modelOptionsByInstance={modelOptionsByInstance}
                  providerEntries={providerEntries}
                  providers={providers}
                  prompt={form.prompt}
                  selection={form.modelSelection ?? effectiveModelSelection}
                  settings={settings}
                  onPromptChange={(prompt) => onFormChange((current) => ({ ...current, prompt }))}
                  onSelectionChange={(modelSelection) =>
                    onFormChange((current) => ({ ...current, modelSelection }))
                  }
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={saving || !form.projectId || !form.prompt.trim()}
                  onClick={onSubmit}
                >
                  {saving ? "Creating" : "Create"}
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <AutomationField label="Start time">
                <Input
                  aria-label="Start time"
                  type="datetime-local"
                  value={form.startAt}
                  onChange={(event) => {
                    const { value } = event.currentTarget;
                    onFormChange((current) => ({ ...current, startAt: value }));
                  }}
                />
              </AutomationField>
              {form.cadence !== "once" ? (
                <AutomationField label="Interval">
                  <Input
                    aria-label="Interval"
                    min={1}
                    type="number"
                    value={form.interval}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      onFormChange((current) => ({ ...current, interval: value }));
                    }}
                  />
                </AutomationField>
              ) : null}
              {form.cadence === "monthly" ? (
                <AutomationField label="Day of month">
                  <Input
                    aria-label="Day of month"
                    max={31}
                    min={1}
                    type="number"
                    value={form.monthDay}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      onFormChange((current) => ({ ...current, monthDay: value }));
                    }}
                  />
                </AutomationField>
              ) : null}
              <div className="flex items-end gap-2 pb-1 text-xs text-muted-foreground">
                <Switch
                  checked={form.catchUp}
                  aria-label="Catch up missed runs"
                  onCheckedChange={(checked) =>
                    onFormChange((current) => ({ ...current, catchUp: Boolean(checked) }))
                  }
                />
                Catch up missed runs
              </div>
            </div>

            {form.cadence === "weekly" ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {WEEKDAYS.map((weekday) => (
                  <label
                    key={weekday.value}
                    className="inline-flex h-7 items-center gap-2 rounded-md border border-input px-2 text-xs"
                  >
                    <Checkbox
                      checked={form.weekdays.includes(weekday.value)}
                      onCheckedChange={(checked) =>
                        onFormChange((current) => ({
                          ...current,
                          weekdays: checked
                            ? [...current.weekdays, weekday.value]
                            : current.weekdays.filter((day) => day !== weekday.value),
                        }))
                      }
                    />
                    {weekday.label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function AutomationsSettingsPanel() {
  const router = useRouter();
  const settings = useSettings();
  const rawProviders = useServerProviders();
  const providers = useMemo(
    () =>
      filterVisibleServerProviders(
        applyProvidersSkillPreferences(rawProviders, settings.providerSkillPreferences),
      ),
    [rawProviders, settings.providerSkillPreferences],
  );
  const providerEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerEntries, settings]);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, primaryEnvironmentId)),
  );
  const allThreads = useStore(
    useShallow((state) => selectThreadsForEnvironment(state, primaryEnvironmentId)),
  );
  const [form, setForm] = useState(() => initialFormState(timezone));
  const projectThreads = useMemo(
    () =>
      form.projectId
        ? allThreads.filter((thread) => thread.projectId === (form.projectId as ProjectId))
        : [],
    [allThreads, form.projectId],
  );
  const [tasks, setTasks] = useState<ReadonlyArray<ScheduledTask>>([]);
  const [runsByTaskId, setRunsByTaskId] = useState<Record<string, ReadonlyArray<ScheduledTaskRun>>>(
    {},
  );
  const [selectedTaskId, setSelectedTaskIdState] = useState<string | null>(null);
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  const setSelectedTaskId = useCallback((taskId: string | null) => {
    selectedTaskIdRef.current = taskId;
    setSelectedTaskIdState(taskId);
  }, []);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<ScheduledTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateSequenceByTaskIdRef = useRef(new Map<ScheduledTask["id"], number>());
  const taskOperationQueueByTaskIdRef = useRef(new Map<ScheduledTask["id"], Promise<void>>());

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const threadById = useMemo(
    () => new Map(allThreads.map((thread) => [thread.id, thread])),
    [allThreads],
  );
  const selectedProject = form.projectId ? projectById.get(form.projectId as ProjectId) : null;
  const selectedThread = form.targetThreadId
    ? threadById.get(form.targetThreadId as ThreadId)
    : null;
  const effectiveFormModelSelection = useMemo(
    () =>
      preferredModelSelectionForTarget({
        explicit: form.modelSelection,
        threadModelSelection: form.kind === "thread" ? selectedThread?.modelSelection : null,
        projectModelSelection: selectedProject?.defaultModelSelection,
        settings,
        providers,
        entries: providerEntries,
        prompt: form.prompt,
      }),
    [
      form.kind,
      form.modelSelection,
      form.prompt,
      providerEntries,
      providers,
      selectedProject?.defaultModelSelection,
      selectedThread?.modelSelection,
      settings,
    ],
  );
  const selectedTask = selectedTaskId
    ? (tasks.find((task) => task.id === selectedTaskId && task.status !== "deleted") ?? null)
    : null;
  const visibleTasks = tasks.filter((task) => task.status !== "deleted");
  const activeTasks = visibleTasks.filter((task) => task.status === "active");
  const pausedTasks = visibleTasks.filter((task) => task.status === "paused");

  const updateForm = useCallback(
    (updater: (current: AutomationFormState) => AutomationFormState) => {
      setForm(updater);
    },
    [],
  );

  useEffect(() => {
    if (!form.projectId && projects[0]) {
      setForm((current) => ({ ...current, projectId: projects[0]!.id }));
    }
  }, [form.projectId, projects]);

  useEffect(() => {
    if (form.kind !== "thread") return;
    if (form.targetThreadId && projectThreads.some((thread) => thread.id === form.targetThreadId)) {
      return;
    }
    setForm((current) => ({ ...current, targetThreadId: projectThreads[0]?.id ?? "" }));
  }, [form.kind, form.targetThreadId, projectThreads]);

  useEffect(() => {
    if (
      selectedTaskId &&
      !tasks.some((task) => task.id === selectedTaskId && task.status !== "deleted")
    ) {
      setSelectedTaskId(null);
    }
  }, [selectedTaskId, setSelectedTaskId, tasks]);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ensureLocalApi().server.scheduledTasks.list();
      setTasks(result.tasks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const loadRuns = useCallback(async (taskId: string) => {
    try {
      const result = await ensureLocalApi().server.scheduledTasks.listRuns({
        taskId: taskId as ScheduledTask["id"],
      });
      setRunsByTaskId((current) => ({ ...current, [taskId]: result.runs }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load run history.");
    }
  }, []);

  const selectTask = useCallback(
    (task: ScheduledTask) => {
      setSelectedTaskId(task.id);
      void loadRuns(task.id);
    },
    [loadRuns, setSelectedTaskId],
  );

  const submitCreate = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.projectId) throw new Error("Choose a project.");
      if (form.kind === "thread" && !form.targetThreadId) throw new Error("Choose a thread.");
      const schedule = buildSchedule(form);
      const result = await ensureLocalApi().server.scheduledTasks.create({
        name: form.name.trim() || "Scheduled automation",
        kind: form.kind,
        projectId: form.projectId as ProjectId,
        targetThreadId: form.kind === "thread" ? (form.targetThreadId as ThreadId) : null,
        prompt: form.prompt.trim(),
        timezone: form.timezone.trim() || timezone,
        catchUp: form.catchUp,
        modelSelection: form.modelSelection ?? effectiveFormModelSelection,
        ...schedule,
      });
      setForm((current) => ({
        ...initialFormState(timezone),
        projectId: current.projectId,
        targetThreadId: current.targetThreadId,
        modelSelection: current.modelSelection ?? effectiveFormModelSelection,
      }));
      setCreateOpen(false);
      setSelectedTaskId(result.task.id);
      await loadTasks();
      await loadRuns(result.task.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create automation.");
    } finally {
      setSaving(false);
    }
  }, [effectiveFormModelSelection, form, loadRuns, loadTasks, setSelectedTaskId, timezone]);

  const enqueueTaskOperation = useCallback(
    (taskId: ScheduledTask["id"], operation: () => Promise<void>) => {
      const previous = taskOperationQueueByTaskIdRef.current.get(taskId) ?? Promise.resolve();
      const tracked = previous
        .catch(() => undefined)
        .then(operation)
        .finally(() => {
          if (taskOperationQueueByTaskIdRef.current.get(taskId) === tracked) {
            taskOperationQueueByTaskIdRef.current.delete(taskId);
          }
        });
      taskOperationQueueByTaskIdRef.current.set(taskId, tracked);
      return tracked;
    },
    [],
  );

  const updateTaskPatch = useCallback(
    async (task: ScheduledTask, patch: ScheduledTaskUpdateInput["patch"]) => {
      const nextSequence = (updateSequenceByTaskIdRef.current.get(task.id) ?? 0) + 1;
      updateSequenceByTaskIdRef.current.set(task.id, nextSequence);
      const mutationKey = `${task.id}:update:${nextSequence}`;
      setMutatingTaskId(mutationKey);
      setError(null);
      try {
        await enqueueTaskOperation(task.id, async () => {
          const result = await ensureLocalApi().server.scheduledTasks.update({
            id: task.id,
            patch,
          });
          setTasks((current) =>
            current.map((candidate) => (candidate.id === task.id ? result.task : candidate)),
          );
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to update automation.");
      } finally {
        setMutatingTaskId((current) => (current === mutationKey ? null : current));
      }
    },
    [enqueueTaskOperation],
  );

  const mutateTask = useCallback(
    async (task: ScheduledTask, action: "pause" | "resume" | "run" | "delete") => {
      setMutatingTaskId(`${task.id}:${action}`);
      setError(null);
      try {
        await enqueueTaskOperation(task.id, async () => {
          const api = ensureLocalApi().server.scheduledTasks;
          if (action === "pause") await api.pause({ id: task.id });
          if (action === "resume") await api.resume({ id: task.id });
          if (action === "run") await api.runNow({ id: task.id });
          if (action === "delete") await api.delete({ id: task.id });
          await loadTasks();
          if (selectedTaskIdRef.current === task.id) {
            if (action === "delete") setSelectedTaskId(null);
            else await loadRuns(task.id);
          }
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Failed to ${action} automation.`);
      } finally {
        setMutatingTaskId(null);
      }
    },
    [enqueueTaskOperation, loadRuns, loadTasks, setSelectedTaskId],
  );

  const confirmDeleteTask = useCallback(async () => {
    if (!pendingDeleteTask) return;
    await mutateTask(pendingDeleteTask, "delete");
    setPendingDeleteTask(null);
  }, [mutateTask, pendingDeleteTask]);

  const openCreateViaChat = useCallback(async () => {
    const targetProject = selectedProject ?? projects[0] ?? null;
    if (!primaryEnvironmentId || !targetProject) {
      setError("Choose a project before creating via chat.");
      return;
    }
    const draftId = newDraftId();
    const threadId = newThreadId();
    const projectRef = scopeProjectRef(primaryEnvironmentId, targetProject.id);
    const draftStore = useComposerDraftStore.getState();
    draftStore.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      envMode: "local",
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
    draftStore.setPrompt(draftId, CREATE_VIA_CHAT_PROMPT);
    draftStore.setModelSelection(draftId, effectiveFormModelSelection);
    await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  }, [effectiveFormModelSelection, primaryEnvironmentId, projects, router, selectedProject]);

  const selectedTaskProject = selectedTask ? projectById.get(selectedTask.projectId) : null;
  const selectedTaskThread = selectedTask?.targetThreadId
    ? threadById.get(selectedTask.targetThreadId)
    : null;
  const selectedTaskRuns = selectedTask ? (runsByTaskId[selectedTask.id] ?? []) : [];
  const pendingDeleteBusy = pendingDeleteTask
    ? mutatingTaskId === `${pendingDeleteTask.id}:delete`
    : false;
  const selectedTaskPreferredModel = selectedTask
    ? preferredModelSelectionForTarget({
        explicit: selectedTask.modelSelection,
        threadModelSelection: selectedTaskThread?.modelSelection,
        projectModelSelection: selectedTaskProject?.defaultModelSelection,
        settings,
        providers,
        entries: providerEntries,
        prompt: selectedTask.prompt,
      })
    : effectiveFormModelSelection;

  return (
    <SettingsPageContainer className="max-w-6xl gap-6">
      {selectedTask ? (
        <AutomationDetail
          task={selectedTask}
          runs={selectedTaskRuns}
          projects={projects}
          threads={allThreads}
          preferredSelection={selectedTaskPreferredModel}
          providerEntries={providerEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          settings={settings}
          providers={providers}
          busy={mutatingTaskId?.startsWith(`${selectedTask.id}:`) ?? false}
          onBack={() => setSelectedTaskId(null)}
          onMutate={(task, action) => void mutateTask(task, action)}
          onDelete={setPendingDeleteTask}
          onUpdate={(task, patch) => void updateTaskPatch(task, patch)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-5xl font-semibold tracking-[-0.05em] text-foreground">
              Automations
            </h1>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="lg"
                    className="rounded-xl bg-foreground text-background hover:bg-foreground/90"
                  />
                }
              >
                Create via chat
                <ChevronDownIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setCreateOpen(true)}>
                  <PlusIcon className="size-4" />
                  Create manually
                </MenuItem>
                <MenuItem onClick={() => void openCreateViaChat()}>
                  <PlayIcon className="size-4" />
                  Create via chat
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>

          {loading ? (
            <div className="rounded-xl bg-muted/40 px-4 py-8 text-sm text-muted-foreground">
              Loading automations.
            </div>
          ) : visibleTasks.length === 0 ? (
            <div className="rounded-xl bg-muted/40 px-4 py-12 text-center">
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-background">
                <Clock3Icon className="size-5 text-muted-foreground" />
              </div>
              <div className="font-medium">No automations</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Scheduled runs will appear here.
              </div>
            </div>
          ) : (
            <>
              <AutomationListSection
                title="Current"
                tasks={activeTasks}
                selectedTaskId={selectedTaskId}
                projectById={projectById}
                threadById={threadById}
                mutatingTaskId={mutatingTaskId}
                onSelect={selectTask}
                onMutate={(task, action) => void mutateTask(task, action)}
                onDelete={setPendingDeleteTask}
              />
              <AutomationListSection
                title="Paused"
                tasks={pausedTasks}
                selectedTaskId={selectedTaskId}
                projectById={projectById}
                threadById={threadById}
                mutatingTaskId={mutatingTaskId}
                onSelect={selectTask}
                onMutate={(task, action) => void mutateTask(task, action)}
                onDelete={setPendingDeleteTask}
              />
            </>
          )}
        </>
      )}

      {error ? <AutomationErrorBanner message={error} /> : null}

      <AutomationCreateDialog
        open={createOpen}
        form={form}
        projects={projects}
        projectThreads={projectThreads}
        projectName={selectedProject?.name}
        threadTitle={selectedThread?.title}
        saving={saving}
        error={error}
        effectiveModelSelection={effectiveFormModelSelection}
        providerEntries={providerEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        settings={settings}
        providers={providers}
        onOpenChange={setCreateOpen}
        onFormChange={updateForm}
        onSubmit={() => void submitCreate()}
      />

      <AlertDialog
        open={Boolean(pendingDeleteTask)}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTask(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete automation "{pendingDeleteTask?.name ?? "this automation"}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the schedule and any future runs. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button disabled={pendingDeleteBusy} variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={pendingDeleteBusy}
              variant="destructive"
              onClick={() => void confirmDeleteTask()}
            >
              Delete automation
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}

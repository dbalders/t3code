import { Clock3Icon, HistoryIcon, PauseIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ProjectId,
  ScheduledTask,
  ScheduledTaskRRuleConfig,
  ScheduledTaskRun,
  ScheduledTaskWeekday,
  ThreadId,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { ensureLocalApi } from "~/localApi";
import {
  selectProjectsForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  useStore,
} from "~/store";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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

const KIND_LABELS: Record<ScheduledTask["kind"], string> = {
  standalone: "New thread each run",
  thread: "Existing thread",
};

const CADENCE_LABELS: Record<Cadence, string> = {
  daily: "Daily",
  monthly: "Monthly",
  once: "Once",
  weekly: "Weekly",
};

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
    kind: "thread",
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
  };
}

function isAutomationKind(value: unknown): value is ScheduledTask["kind"] {
  return value === "thread" || value === "standalone";
}

function isCadence(value: unknown): value is Cadence {
  return value === "once" || value === "daily" || value === "weekly" || value === "monthly";
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
  if (!config) return "Recurring schedule";
  const interval = config.interval === 1 ? "" : ` every ${config.interval}`;
  if (config.frequency === "weekly" && config.byDay?.length) {
    return `Weekly${interval} on ${config.byDay.join(", ")}`;
  }
  if (config.frequency === "monthly" && config.byMonthDay?.length) {
    return `Monthly${interval} on day ${config.byMonthDay.join(", ")}`;
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

function runStatusVariant(status: ScheduledTaskRun["status"]) {
  switch (status) {
    case "success":
      return "success";
    case "failure":
      return "error";
    case "skipped":
    case "canceled":
      return "warning";
    case "queued":
    case "running":
      return "info";
  }
}

function buildSchedule(form: AutomationFormState): {
  readonly scheduleKind: ScheduledTask["scheduleKind"];
  readonly scheduleValue: string;
} {
  const startAtIso = new Date(form.startAt).toISOString();
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

function IconButton({
  label,
  disabled,
  onClick,
  variant = "outline",
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly variant?: "outline" | "ghost" | "destructive-outline";
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            size="icon-xs"
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

function SelectDisplayValue({
  children,
  placeholder = false,
}: {
  readonly children: ReactNode;
  readonly placeholder?: boolean;
}) {
  return (
    <span className={cn("flex-1 truncate", placeholder && "text-muted-foreground")}>
      {children}
    </span>
  );
}

export function AutomationsSettingsPanel() {
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, primaryEnvironmentId)),
  );
  const allThreads = useStore(
    useShallow((state) =>
      selectSidebarThreadsAcrossEnvironments(state).filter(
        (thread) => thread.environmentId === primaryEnvironmentId,
      ),
    ),
  );
  const [form, setForm] = useState(() => initialFormState(timezone));
  const projectThreads = useStore(
    useShallow((state) =>
      primaryEnvironmentId && form.projectId
        ? selectSidebarThreadsForProjectRef(state, {
            environmentId: primaryEnvironmentId,
            projectId: form.projectId as ProjectId,
          })
        : [],
    ),
  );
  const [tasks, setTasks] = useState<ReadonlyArray<ScheduledTask>>([]);
  const [runsByTaskId, setRunsByTaskId] = useState<Record<string, ReadonlyArray<ScheduledTaskRun>>>(
    {},
  );
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mutatingTaskId, setMutatingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const threadById = useMemo(
    () => new Map(allThreads.map((thread) => [thread.id, thread])),
    [allThreads],
  );
  const selectedProjectName = form.projectId
    ? projectById.get(form.projectId as ProjectId)?.name
    : undefined;
  const selectedThreadTitle = form.targetThreadId
    ? threadById.get(form.targetThreadId as ThreadId)?.title
    : undefined;

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

  const submitCreate = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (!form.projectId) throw new Error("Choose a project.");
      if (form.kind === "thread" && !form.targetThreadId) throw new Error("Choose a thread.");
      const schedule = buildSchedule(form);
      await ensureLocalApi().server.scheduledTasks.create({
        name: form.name.trim() || "Scheduled automation",
        kind: form.kind,
        projectId: form.projectId as ProjectId,
        targetThreadId: form.kind === "thread" ? (form.targetThreadId as ThreadId) : null,
        prompt: form.prompt.trim(),
        timezone: form.timezone.trim() || timezone,
        catchUp: form.catchUp,
        ...schedule,
      });
      setForm((current) => ({
        ...initialFormState(timezone),
        projectId: current.projectId,
        targetThreadId: current.targetThreadId,
      }));
      await loadTasks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create automation.");
    } finally {
      setSaving(false);
    }
  }, [form, loadTasks, timezone]);

  const mutateTask = useCallback(
    async (task: ScheduledTask, action: "pause" | "resume" | "run" | "delete") => {
      setMutatingTaskId(`${task.id}:${action}`);
      setError(null);
      try {
        const api = ensureLocalApi().server.scheduledTasks;
        if (action === "pause") await api.pause({ id: task.id });
        if (action === "resume") await api.resume({ id: task.id });
        if (action === "run") await api.runNow({ id: task.id });
        if (action === "delete") await api.delete({ id: task.id });
        await loadTasks();
        if (expandedTaskId === task.id) await loadRuns(task.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `Failed to ${action} automation.`);
      } finally {
        setMutatingTaskId(null);
      }
    },
    [expandedTaskId, loadRuns, loadTasks],
  );

  const toggleRuns = useCallback(
    async (taskId: string) => {
      const nextTaskId = expandedTaskId === taskId ? null : taskId;
      setExpandedTaskId(nextTaskId);
      if (nextTaskId && !runsByTaskId[nextTaskId]) {
        await loadRuns(nextTaskId);
      }
    },
    [expandedTaskId, loadRuns, runsByTaskId],
  );

  return (
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection title="Create Automation" icon={<Clock3Icon className="size-3.5" />}>
        <div className="grid gap-3 border-t border-border/60 p-4 first:border-t-0 sm:grid-cols-2 sm:p-5">
          <AutomationField label="Name">
            <Input
              aria-label="Automation name"
              placeholder="Name"
              value={form.name}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setForm((current) => ({ ...current, name: value }));
              }}
            />
          </AutomationField>
          <AutomationField label="Run mode">
            <Select
              value={form.kind}
              onValueChange={(value) => {
                if (!isAutomationKind(value)) return;
                setForm((current) => ({ ...current, kind: value }));
              }}
            >
              <SelectTrigger aria-label="Run mode">
                <SelectDisplayValue>{KIND_LABELS[form.kind]}</SelectDisplayValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thread">Existing thread</SelectItem>
                <SelectItem value="standalone">New thread each run</SelectItem>
              </SelectContent>
            </Select>
          </AutomationField>

          <AutomationField label="Project">
            <Select
              value={form.projectId}
              onValueChange={(value) => {
                if (!value) return;
                setForm((current) => ({ ...current, projectId: value, targetThreadId: "" }));
              }}
            >
              <SelectTrigger aria-label="Project">
                <SelectDisplayValue placeholder={!selectedProjectName}>
                  {selectedProjectName ?? "Project"}
                </SelectDisplayValue>
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </AutomationField>

          {form.kind === "thread" ? (
            <AutomationField label="Thread">
              <Select
                value={form.targetThreadId}
                onValueChange={(value) => {
                  if (!value) return;
                  setForm((current) => ({ ...current, targetThreadId: value }));
                }}
              >
                <SelectTrigger aria-label="Thread">
                  <SelectDisplayValue placeholder={!selectedThreadTitle}>
                    {selectedThreadTitle ?? "Thread"}
                  </SelectDisplayValue>
                </SelectTrigger>
                <SelectContent>
                  {projectThreads.map((thread) => (
                    <SelectItem key={thread.id} value={thread.id}>
                      {thread.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </AutomationField>
          ) : (
            <AutomationField label="Timezone">
              <Input aria-label="Timezone" value={form.timezone} readOnly />
            </AutomationField>
          )}

          <AutomationField label="Schedule">
            <Select
              value={form.cadence}
              onValueChange={(value) => {
                if (!isCadence(value)) return;
                setForm((current) => ({ ...current, cadence: value }));
              }}
            >
              <SelectTrigger aria-label="Schedule">
                <SelectDisplayValue>{CADENCE_LABELS[form.cadence]}</SelectDisplayValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">Once</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </AutomationField>
          <AutomationField label="Start time">
            <Input
              aria-label="Start time"
              type="datetime-local"
              value={form.startAt}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setForm((current) => ({ ...current, startAt: value }));
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
                  setForm((current) => ({ ...current, interval: value }));
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
                  setForm((current) => ({ ...current, monthDay: value }));
                }}
              />
            </AutomationField>
          ) : null}

          {form.cadence === "weekly" ? (
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              {WEEKDAYS.map((weekday) => (
                <label
                  key={weekday.value}
                  className="inline-flex h-7 items-center gap-2 rounded-md border border-input px-2 text-xs"
                >
                  <Checkbox
                    checked={form.weekdays.includes(weekday.value)}
                    onCheckedChange={(checked) =>
                      setForm((current) => ({
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

          <AutomationField label="Prompt" className="sm:col-span-2">
            <Textarea
              aria-label="Automation prompt"
              placeholder="Prompt"
              value={form.prompt}
              onChange={(event) => {
                const { value } = event.currentTarget;
                setForm((current) => ({ ...current, prompt: value }));
              }}
            />
          </AutomationField>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={form.catchUp}
              aria-label="Catch up missed runs"
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, catchUp: Boolean(checked) }))
              }
            />
            Catch up missed runs
          </div>
          <div className="flex justify-end">
            <Button
              disabled={saving || !form.projectId || !form.prompt.trim()}
              onClick={() => void submitCreate()}
              size="sm"
            >
              <PlusIcon className="size-4" />
              {saving ? "Creating" : "Create"}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Automations" headerAction={loading ? null : `${tasks.length}`}>
        {tasks.length === 0 ? (
          <SettingsRow
            title={loading ? "Loading automations" : "No automations"}
            description={
              loading
                ? "Loading scheduled automation records."
                : "Create an automation to run prompts on a schedule."
            }
          />
        ) : (
          tasks.map((task) => {
            const project = projectById.get(task.projectId);
            const thread = task.targetThreadId ? threadById.get(task.targetThreadId) : null;
            const runs = runsByTaskId[task.id] ?? [];
            const expanded = expandedTaskId === task.id;
            const taskBusy = mutatingTaskId?.startsWith(`${task.id}:`) ?? false;
            return (
              <SettingsRow
                key={task.id}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{task.name}</span>
                    <Badge size="sm" variant={statusVariant(task.status)}>
                      {task.status}
                    </Badge>
                  </span>
                }
                description={task.prompt}
                status={
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate">
                      {formatSchedule(task)} / next {formatDateTime(task.nextRunAt)}
                    </span>
                    <span className="truncate">
                      {project?.name ?? task.projectId}
                      {task.kind === "thread"
                        ? ` / ${thread?.title ?? task.targetThreadId ?? "Thread"}`
                        : " / New thread"}
                    </span>
                  </div>
                }
                control={
                  <div className="flex items-center gap-1">
                    <IconButton
                      disabled={taskBusy}
                      label="Run now"
                      onClick={() => void mutateTask(task, "run")}
                    >
                      <PlayIcon className="size-3.5" />
                    </IconButton>
                    <IconButton
                      disabled={taskBusy}
                      label={task.status === "active" ? "Pause" : "Resume"}
                      onClick={() =>
                        void mutateTask(task, task.status === "active" ? "pause" : "resume")
                      }
                    >
                      {task.status === "active" ? (
                        <PauseIcon className="size-3.5" />
                      ) : (
                        <PlayIcon className="size-3.5" />
                      )}
                    </IconButton>
                    <IconButton
                      disabled={taskBusy}
                      label="History"
                      onClick={() => void toggleRuns(task.id)}
                    >
                      <HistoryIcon className="size-3.5" />
                    </IconButton>
                    <IconButton
                      disabled={taskBusy}
                      label="Delete"
                      onClick={() => void mutateTask(task, "delete")}
                      variant="destructive-outline"
                    >
                      <Trash2Icon className="size-3.5" />
                    </IconButton>
                  </div>
                }
              >
                {expanded ? (
                  <div className="mt-3 border-t border-border/60 py-2">
                    {runs.length === 0 ? (
                      <div className="px-1 py-2 text-xs text-muted-foreground">No runs yet.</div>
                    ) : (
                      <div className="grid gap-1">
                        {runs.slice(0, 8).map((run) => (
                          <div
                            key={run.id}
                            className={cn(
                              "grid gap-2 rounded-md px-2 py-1.5 text-xs sm:grid-cols-[7rem_1fr_9rem]",
                              "bg-muted/40 text-muted-foreground",
                            )}
                          >
                            <Badge size="sm" variant={runStatusVariant(run.status)}>
                              {run.status}
                            </Badge>
                            <span className="truncate">
                              {run.error ?? run.resultSummary ?? run.id}
                            </span>
                            <span className="truncate text-right">
                              {formatDateTime(run.scheduledFor)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>

      {error ? (
        <SettingsSection title="Automation Error">
          <SettingsRow title="Request failed" description={error} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

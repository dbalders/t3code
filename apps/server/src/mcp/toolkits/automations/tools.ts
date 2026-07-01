import {
  IsoDateTime,
  ModelSelection,
  PositiveInt,
  ProjectId,
  ProviderInteractionMode,
  ScheduledTaskDeleteResult,
  ScheduledTaskError,
  ScheduledTaskMutationResult,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRRuleFrequency,
  ScheduledTaskRunNowResult,
  ScheduledTasksListResult,
  ScheduledTaskScheduleKind,
  ScheduledTaskStatus,
  ScheduledTaskWeekday,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ScheduledTaskService,
  ProjectionSnapshotQuery,
];

const optionalDescribed = <A>(schema: Schema.Schema<A>, description: string) =>
  Schema.optional(schema.annotate({ description })).annotate({ description });

const AutomationText = Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty());
const AutomationIdText = AutomationText.check(Schema.isMaxLength(256)).annotate({
  description: "Automation id. Use automation_list first if you do not know it.",
});

const AutomationTarget = Schema.Literals(["current_thread", "new_thread"]).annotate({
  description:
    "Where the automation should deliver future runs. current_thread appends to this chat; new_thread creates a fresh thread in this chat's project for each run.",
});

const AutomationStatusFilter = Schema.Literals(["active", "paused", "deleted", "all"]).annotate({
  description: "Filter automations by status. Omit to hide deleted tasks; use all to include them.",
});

const AutomationListToolInput = Schema.Struct({
  status: optionalDescribed(
    AutomationStatusFilter,
    "Filter returned automations by status. Defaults to all non-deleted tasks.",
  ),
  targetThreadId: optionalDescribed(
    ThreadId,
    "Only return automations that append to this thread id.",
  ),
  currentThreadOnly: optionalDescribed(
    Schema.Boolean,
    "When true, only return automations associated with the chat that is calling this tool.",
  ),
}).annotate({
  description:
    "List scheduled automations so you can inspect ids, schedules, prompts, status, model choices, and thread targets before editing or deleting them.",
});

const AutomationMutationScheduleFields = {
  scheduleKind: optionalDescribed(
    ScheduledTaskScheduleKind,
    "Schedule shape to create or edit. Use once with runAt/startAt for a one-time run; use rrule with frequency/startAt for recurrence.",
  ),
  runAt: optionalDescribed(
    IsoDateTime,
    "ISO date-time for a one-time run. Example: 2026-06-21T09:00:00-07:00.",
  ),
  startAt: optionalDescribed(
    IsoDateTime,
    "ISO date-time for the first run of a recurring automation, or a fallback value for a one-time automation.",
  ),
  frequency: optionalDescribed(
    ScheduledTaskRRuleFrequency,
    "Recurring cadence. Required with scheduleKind rrule; choose daily, weekly, or monthly.",
  ),
  interval: optionalDescribed(PositiveInt, "Repeat every N frequency units. Defaults to 1."),
  byDay: optionalDescribed(
    Schema.Array(ScheduledTaskWeekday),
    "Weekly days to run, for example ['MO','WE','FR']. Use only with weekly recurrence.",
  ),
  byMonthDay: optionalDescribed(
    Schema.Array(PositiveInt.check(Schema.isLessThanOrEqualTo(31))),
    "Calendar month days to run, from 1 through 31. Use only with monthly recurrence.",
  ),
  count: optionalDescribed(PositiveInt, "Optional number of recurring runs before stopping."),
  until: optionalDescribed(
    IsoDateTime,
    "Optional ISO date-time after which a recurring automation should stop.",
  ),
};

const AutomationMutableFields = {
  name: optionalDescribed(
    AutomationText,
    "Short human-readable automation title. If omitted on create, TritonAI Harness derives one from the prompt.",
  ),
  prompt: optionalDescribed(
    AutomationText,
    "Prompt the assistant should run when the automation fires.",
  ),
  target: optionalDescribed(
    AutomationTarget,
    "Delivery target. Defaults to current_thread unless targetThreadId is omitted and new_thread is explicitly requested.",
  ),
  projectId: optionalDescribed(
    ProjectId,
    "Project id to run in. Chat-created automations may only use the current thread's project.",
  ),
  targetThreadId: optionalDescribed(
    ThreadId,
    "Existing thread id that future runs should append to. Chat-created automations may only target the current thread.",
  ),
  timezone: optionalDescribed(
    AutomationText,
    "IANA timezone such as America/Los_Angeles. Omit to use UTC from the tool layer when not supplied by the UI.",
  ),
  status: optionalDescribed(
    ScheduledTaskStatus,
    "Automation status. Use active to run normally or paused to create/update without future execution.",
  ),
  modelSelection: optionalDescribed(
    Schema.NullOr(ModelSelection),
    "Optional explicit provider instance, model, and thinking/options for this automation. Null clears the override.",
  ),
  interactionMode: optionalDescribed(
    ProviderInteractionMode,
    "Optional interaction mode for future runs, usually default.",
  ),
  overlapPolicy: optionalDescribed(
    ScheduledTaskOverlapPolicy,
    "How to handle overlapping due runs. The current supported value is skip.",
  ),
  catchUp: optionalDescribed(
    Schema.Boolean,
    "Whether missed recurring runs should catch up. Defaults to false.",
  ),
  ...AutomationMutationScheduleFields,
};

export const AutomationCreateToolInput = Schema.Struct({
  ...AutomationMutableFields,
  prompt: AutomationText.annotate({
    description: "Prompt the assistant should run when the automation fires.",
  }),
}).annotate({
  description:
    "Create a scheduled automation scoped to this chat. Defaults to this chat's thread/project unless target:'new_thread' is provided.",
});
export type AutomationCreateToolInput = typeof AutomationCreateToolInput.Type;

export const AutomationUpdateToolInput = Schema.Struct({
  id: AutomationIdText,
  ...AutomationMutableFields,
}).annotate({
  description:
    "Edit an existing scheduled automation. Only provided fields change; omit fields that should stay the same.",
});
export type AutomationUpdateToolInput = typeof AutomationUpdateToolInput.Type;

export const AutomationIdToolInput = Schema.Struct({
  id: AutomationIdText,
}).annotate({
  description: "Identifies a scheduled automation by id.",
});

const readonlyAutomationTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false) as T;

const mutatingAutomationTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, true) as T;

export const AutomationListTool = readonlyAutomationTool(
  Tool.make("automation_list", {
    description:
      "List the user's scheduled automations. Use before editing, deleting, pausing, resuming, or answering questions about existing automations.",
    parameters: AutomationListToolInput,
    success: ScheduledTasksListResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "List automations"),
);

export const AutomationCreateTool = mutatingAutomationTool(
  Tool.make("automation_create", {
    description:
      "Create a scheduled automation that runs a prompt later or on a recurrence. Prefer target current_thread when the user wants this chat to receive future runs, and target new_thread when each run should make a new thread.",
    parameters: AutomationCreateToolInput,
    success: ScheduledTaskMutationResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "Create automation"),
);

export const AutomationUpdateTool = mutatingAutomationTool(
  Tool.make("automation_update", {
    description:
      "Edit an existing scheduled automation's title, prompt, schedule, target thread/project, status, model, or thinking/options.",
    parameters: AutomationUpdateToolInput,
    success: ScheduledTaskMutationResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "Update automation"),
);

export const AutomationDeleteTool = mutatingAutomationTool(
  Tool.make("automation_delete", {
    description:
      "Delete a scheduled automation so it will no longer run. Use automation_list first when the id is uncertain.",
    parameters: AutomationIdToolInput,
    success: ScheduledTaskDeleteResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "Delete automation"),
);

export const AutomationPauseTool = mutatingAutomationTool(
  Tool.make("automation_pause", {
    description:
      "Pause a scheduled automation without deleting it. Future runs stop until automation_resume is called.",
    parameters: AutomationIdToolInput,
    success: ScheduledTaskMutationResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "Pause automation"),
);

export const AutomationResumeTool = mutatingAutomationTool(
  Tool.make("automation_resume", {
    description:
      "Resume a paused scheduled automation and recompute its next run from the current time.",
    parameters: AutomationIdToolInput,
    success: ScheduledTaskMutationResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "Resume automation"),
);

export const AutomationRunNowTool = mutatingAutomationTool(
  Tool.make("automation_run_now", {
    description:
      "Run a scheduled automation immediately without waiting for its next scheduled occurrence.",
    parameters: AutomationIdToolInput,
    success: ScheduledTaskRunNowResult,
    failure: ScheduledTaskError,
    dependencies,
  }).annotate(Tool.Title, "Run automation now"),
);

export const AutomationToolkit = Toolkit.make(
  AutomationListTool,
  AutomationCreateTool,
  AutomationUpdateTool,
  AutomationDeleteTool,
  AutomationPauseTool,
  AutomationResumeTool,
  AutomationRunNowTool,
);

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ScheduledTaskRunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export const SCHEDULED_TASKS_WS_METHODS = {
  list: "scheduledTasks.list",
  create: "scheduledTasks.create",
  update: "scheduledTasks.update",
  delete: "scheduledTasks.delete",
  pause: "scheduledTasks.pause",
  resume: "scheduledTasks.resume",
  runNow: "scheduledTasks.runNow",
  listRuns: "scheduledTaskRuns.list",
} as const;

export const ScheduledTaskKind = Schema.Literals(["thread", "standalone"]);
export type ScheduledTaskKind = typeof ScheduledTaskKind.Type;

export const ScheduledTaskScheduleKind = Schema.Literals(["once", "rrule"]);
export type ScheduledTaskScheduleKind = typeof ScheduledTaskScheduleKind.Type;

export const ScheduledTaskStatus = Schema.Literals(["active", "paused", "deleted"]);
export type ScheduledTaskStatus = typeof ScheduledTaskStatus.Type;

export const ScheduledTaskOverlapPolicy = Schema.Literals(["skip"]);
export type ScheduledTaskOverlapPolicy = typeof ScheduledTaskOverlapPolicy.Type;

export const ScheduledTaskRunStatus = Schema.Literals([
  "queued",
  "running",
  "success",
  "failure",
  "skipped",
  "canceled",
]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTaskRRuleFrequency = Schema.Literals(["daily", "weekly", "monthly"]);
export type ScheduledTaskRRuleFrequency = typeof ScheduledTaskRRuleFrequency.Type;

export const ScheduledTaskWeekday = Schema.Literals(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export type ScheduledTaskWeekday = typeof ScheduledTaskWeekday.Type;

export const ScheduledTaskRRuleConfig = Schema.Struct({
  frequency: ScheduledTaskRRuleFrequency,
  interval: PositiveInt,
  dtStart: IsoDateTime,
  byDay: Schema.optional(Schema.Array(ScheduledTaskWeekday)),
  byMonthDay: Schema.optional(Schema.Array(PositiveInt.check(Schema.isLessThanOrEqualTo(31)))),
  count: Schema.optional(PositiveInt),
  until: Schema.optional(IsoDateTime),
});
export type ScheduledTaskRRuleConfig = typeof ScheduledTaskRRuleConfig.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  name: TrimmedNonEmptyString,
  kind: ScheduledTaskKind,
  projectId: ProjectId,
  targetThreadId: Schema.NullOr(ThreadId),
  prompt: TrimmedNonEmptyString,
  scheduleKind: ScheduledTaskScheduleKind,
  scheduleValue: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
  status: ScheduledTaskStatus,
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: Schema.NullOr(RuntimeMode),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  overlapPolicy: ScheduledTaskOverlapPolicy,
  catchUp: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskRun = Schema.Struct({
  id: ScheduledTaskRunId,
  taskId: ScheduledTaskId,
  scheduledFor: IsoDateTime,
  status: ScheduledTaskRunStatus,
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  turnId: Schema.NullOr(TurnId),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledTaskRun = typeof ScheduledTaskRun.Type;

export const ScheduledTaskMutationBase = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: ScheduledTaskKind,
  projectId: ProjectId,
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  prompt: TrimmedNonEmptyString,
  scheduleKind: ScheduledTaskScheduleKind,
  scheduleValue: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
  status: Schema.optional(ScheduledTaskStatus),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(Schema.NullOr(RuntimeMode)),
  interactionMode: Schema.optional(ProviderInteractionMode),
  overlapPolicy: Schema.optional(ScheduledTaskOverlapPolicy),
  catchUp: Schema.optional(Schema.Boolean),
});

export const ScheduledTaskCreateInput = ScheduledTaskMutationBase;
export type ScheduledTaskCreateInput = typeof ScheduledTaskCreateInput.Type;

export const ScheduledTaskUpdateInput = Schema.Struct({
  id: ScheduledTaskId,
  patch: Schema.Struct({
    name: Schema.optional(TrimmedNonEmptyString),
    kind: Schema.optional(ScheduledTaskKind),
    projectId: Schema.optional(ProjectId),
    targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    prompt: Schema.optional(TrimmedNonEmptyString),
    scheduleKind: Schema.optional(ScheduledTaskScheduleKind),
    scheduleValue: Schema.optional(TrimmedNonEmptyString),
    timezone: Schema.optional(TrimmedNonEmptyString),
    status: Schema.optional(ScheduledTaskStatus),
    modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    runtimeMode: Schema.optional(Schema.NullOr(RuntimeMode)),
    interactionMode: Schema.optional(ProviderInteractionMode),
    overlapPolicy: Schema.optional(ScheduledTaskOverlapPolicy),
    catchUp: Schema.optional(Schema.Boolean),
  }),
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;

export const ScheduledTaskIdInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskIdInput = typeof ScheduledTaskIdInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskRunsListInput = Schema.Struct({
  taskId: ScheduledTaskId,
});
export type ScheduledTaskRunsListInput = typeof ScheduledTaskRunsListInput.Type;

export const ScheduledTasksListResult = Schema.Struct({
  tasks: Schema.Array(ScheduledTask),
});
export type ScheduledTasksListResult = typeof ScheduledTasksListResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  run: ScheduledTaskRun,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export const ScheduledTaskRunsListResult = Schema.Struct({
  runs: Schema.Array(ScheduledTaskRun),
});
export type ScheduledTaskRunsListResult = typeof ScheduledTaskRunsListResult.Type;

export class ScheduledTaskError extends Schema.TaggedErrorClass<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

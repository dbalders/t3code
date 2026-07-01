import {
  type ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskRRuleConfig,
  type ScheduledTaskRRuleConfig as ScheduledTaskRRuleConfigType,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import {
  AutomationToolkit,
  type AutomationCreateToolInput,
  type AutomationUpdateToolInput,
} from "./tools.ts";

type AutomationScheduleInput = Pick<
  AutomationUpdateToolInput,
  | "scheduleKind"
  | "runAt"
  | "startAt"
  | "frequency"
  | "interval"
  | "byDay"
  | "byMonthDay"
  | "count"
  | "until"
>;

const rruleConfigStringSchema = Schema.fromJsonString(ScheduledTaskRRuleConfig);
const encodeRRuleConfigString = Schema.encodeSync(rruleConfigStringSchema);
const decodeRRuleConfigString = Schema.decodeUnknownEffect(rruleConfigStringSchema);

const toolError = (message: string, cause?: unknown) =>
  new ScheduledTaskError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });

const requireAutomationScope = Effect.fn("AutomationToolkit.requireScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("automations")) {
    return yield* toolError("MCP credential does not grant the automations capability.");
  }
  return invocation;
});

function normalizeIsoDateTime(
  value: string,
  field: string,
): Effect.Effect<string, ScheduledTaskError> {
  return DateTime.make(value).pipe(
    Option.match({
      onNone: () => Effect.fail(toolError(`${field} must be a valid ISO date-time.`)),
      onSome: (dateTime) => Effect.succeed(DateTime.formatIso(DateTime.toUtc(dateTime))),
    }),
  );
}

function hasScheduleInput(input: AutomationScheduleInput): boolean {
  return (
    input.scheduleKind !== undefined ||
    input.runAt !== undefined ||
    input.startAt !== undefined ||
    input.frequency !== undefined ||
    input.interval !== undefined ||
    input.byDay !== undefined ||
    input.byMonthDay !== undefined ||
    input.count !== undefined ||
    input.until !== undefined
  );
}

function inferScheduleKind(input: AutomationScheduleInput, existingTask?: ScheduledTask) {
  if (input.scheduleKind !== undefined) return input.scheduleKind;
  if (input.runAt !== undefined) return "once";
  if (
    input.startAt !== undefined ||
    input.frequency !== undefined ||
    input.interval !== undefined ||
    input.byDay !== undefined ||
    input.byMonthDay !== undefined ||
    input.count !== undefined ||
    input.until !== undefined
  ) {
    return "rrule";
  }
  return existingTask?.scheduleKind ?? "rrule";
}

const getExistingScheduleInput = Effect.fn("AutomationToolkit.getExistingScheduleInput")(function* (
  task: ScheduledTask,
) {
  if (task.scheduleKind === "once") {
    return {
      scheduleKind: "once",
      runAt: task.scheduleValue,
    };
  }

  const config = yield* decodeRRuleConfigString(task.scheduleValue).pipe(
    Effect.mapError((cause) => toolError("Existing automation schedule is invalid.", cause)),
  );
  return {
    scheduleKind: "rrule",
    startAt: config.dtStart,
    frequency: config.frequency,
    interval: config.interval,
    byDay: config.byDay,
    byMonthDay: config.byMonthDay,
    count: config.count,
    until: config.until,
  };
});

const buildSchedule = Effect.fn("AutomationToolkit.buildSchedule")(function* (
  input: AutomationScheduleInput,
  existingTask?: ScheduledTask,
) {
  const scheduleKind = inferScheduleKind(input, existingTask);
  const existingInput =
    existingTask !== undefined && scheduleKind === existingTask.scheduleKind
      ? yield* getExistingScheduleInput(existingTask)
      : {};
  const mergedInput = { ...existingInput, ...input, scheduleKind };
  if (scheduleKind === "once") {
    const runAt = mergedInput.runAt ?? mergedInput.startAt;
    if (runAt === undefined) {
      return yield* toolError("A one-time automation requires runAt or startAt.");
    }
    return {
      scheduleKind: "once" as const,
      scheduleValue: yield* normalizeIsoDateTime(runAt, "runAt"),
    };
  }

  if (mergedInput.startAt === undefined) {
    return yield* toolError("A recurring automation requires startAt.");
  }
  if (mergedInput.frequency === undefined) {
    return yield* toolError("A recurring automation requires frequency.");
  }
  const config: ScheduledTaskRRuleConfigType = {
    frequency: mergedInput.frequency,
    interval: mergedInput.interval ?? 1,
    dtStart: yield* normalizeIsoDateTime(mergedInput.startAt, "startAt"),
    ...(mergedInput.byDay !== undefined && mergedInput.byDay.length > 0
      ? { byDay: mergedInput.byDay }
      : {}),
    ...(mergedInput.byMonthDay !== undefined && mergedInput.byMonthDay.length > 0
      ? { byMonthDay: mergedInput.byMonthDay }
      : {}),
    ...(mergedInput.count !== undefined ? { count: mergedInput.count } : {}),
    ...(mergedInput.until !== undefined
      ? { until: yield* normalizeIsoDateTime(mergedInput.until, "until") }
      : {}),
  };
  return {
    scheduleKind: "rrule" as const,
    scheduleValue: encodeRRuleConfigString(config),
  };
});

const getThreadProjectId = Effect.fn("AutomationToolkit.getThreadProjectId")(function* (
  threadId: ThreadId,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const thread = yield* projectionSnapshotQuery
    .getThreadShellById(threadId)
    .pipe(Effect.mapError((cause) => toolError("Failed to resolve the target thread.", cause)));
  if (Option.isNone(thread)) {
    return yield* toolError(`Thread '${threadId}' was not found.`);
  }
  return thread.value.projectId;
});

const getInvocationProjectId = Effect.fn("AutomationToolkit.getInvocationProjectId")(function* () {
  const invocation = yield* requireAutomationScope();
  return yield* getThreadProjectId(invocation.threadId);
});

function isTaskAccessibleFromInvocation(
  task: ScheduledTask,
  invocation: McpInvocationContext.McpInvocationScope,
  invocationProjectId: ScheduledTask["projectId"],
): boolean {
  return (
    task.targetThreadId === invocation.threadId ||
    (task.kind === "standalone" && task.projectId === invocationProjectId)
  );
}

const requireTaskAccess = Effect.fn("AutomationToolkit.requireTaskAccess")(function* (
  task: ScheduledTask,
) {
  const invocation = yield* requireAutomationScope();
  const invocationProjectId = yield* getThreadProjectId(invocation.threadId);
  if (!isTaskAccessibleFromInvocation(task, invocation, invocationProjectId)) {
    return yield* toolError("Automation is not accessible from this chat.");
  }
  return task;
});

const getAccessibleTask = Effect.fn("AutomationToolkit.getAccessibleTask")(function* (
  id: ScheduledTaskId,
) {
  const scheduledTasks = yield* ScheduledTaskService;
  const result = yield* scheduledTasks.list();
  const task = result.tasks.find((candidate) => candidate.id === id);
  if (!task) {
    return yield* toolError(`Automation '${id}' was not found.`);
  }
  return yield* requireTaskAccess(task);
});

const ensureCurrentProject = Effect.fn("AutomationToolkit.ensureCurrentProject")(function* (
  projectId: ScheduledTask["projectId"] | undefined,
) {
  const invocationProjectId = yield* getInvocationProjectId();
  if (projectId !== undefined && projectId !== invocationProjectId) {
    return yield* toolError("Automations created from chat must stay in the current project.");
  }
  return invocationProjectId;
});

const ensureCurrentThreadTarget = Effect.fn("AutomationToolkit.ensureCurrentThreadTarget")(
  function* (targetThreadId: ThreadId | undefined) {
    const invocation = yield* requireAutomationScope();
    if (targetThreadId !== undefined && targetThreadId !== invocation.threadId) {
      return yield* toolError("Automations created from chat can only target the current thread.");
    }
    return invocation.threadId;
  },
);

const resolveCreateTarget = Effect.fn("AutomationToolkit.resolveCreateTarget")(function* (
  input: AutomationCreateToolInput,
) {
  const projectId = yield* ensureCurrentProject(input.projectId);
  if (input.target === "new_thread") {
    return { kind: "standalone" as const, projectId, targetThreadId: null };
  }

  const targetThreadId = yield* ensureCurrentThreadTarget(input.targetThreadId);
  return { kind: "thread" as const, projectId, targetThreadId };
});

const buildUpdatePatch = Effect.fn("AutomationToolkit.buildUpdatePatch")(function* (
  input: AutomationUpdateToolInput,
  existingTask: ScheduledTask,
) {
  const invocation = yield* requireAutomationScope();
  const invocationProjectId = yield* ensureCurrentProject(input.projectId);
  const schedule = hasScheduleInput(input) ? yield* buildSchedule(input, existingTask) : null;
  const targetPatch =
    input.target === "new_thread"
      ? {
          kind: "standalone" as const,
          targetThreadId: null,
          projectId: invocationProjectId,
        }
      : input.target === "current_thread"
        ? {
            kind: "thread" as const,
            targetThreadId: invocation.threadId,
            projectId: invocationProjectId,
          }
        : input.targetThreadId !== undefined
          ? {
              kind: "thread" as const,
              targetThreadId: yield* ensureCurrentThreadTarget(input.targetThreadId),
              projectId: invocationProjectId,
            }
          : input.projectId !== undefined
            ? { projectId: invocationProjectId }
            : {};

  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...targetPatch,
    ...(schedule !== null ? schedule : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(input.overlapPolicy !== undefined ? { overlapPolicy: input.overlapPolicy } : {}),
    ...(input.catchUp !== undefined ? { catchUp: input.catchUp } : {}),
  };
});

const handlers = {
  automation_list: (input) =>
    Effect.gen(function* () {
      const invocation = yield* requireAutomationScope();
      const invocationProjectId = yield* getThreadProjectId(invocation.threadId);
      const scheduledTasks = yield* ScheduledTaskService;
      const result = yield* scheduledTasks.list();
      const tasks = result.tasks.filter((task) => {
        if (input.status === undefined && task.status === "deleted") {
          return false;
        }
        if (input.currentThreadOnly === true && task.targetThreadId !== invocation.threadId) {
          return false;
        }
        if (input.targetThreadId !== undefined && task.targetThreadId !== input.targetThreadId) {
          return false;
        }
        if (input.status !== undefined && input.status !== "all" && task.status !== input.status) {
          return false;
        }
        if (!isTaskAccessibleFromInvocation(task, invocation, invocationProjectId)) {
          return false;
        }
        return true;
      });
      return { tasks };
    }),
  automation_create: (input) =>
    Effect.gen(function* () {
      const scheduledTasks = yield* ScheduledTaskService;
      const target = yield* resolveCreateTarget(input);
      const schedule = yield* buildSchedule(input);
      return yield* scheduledTasks.create({
        name: input.name ?? input.prompt.slice(0, 80),
        prompt: input.prompt,
        timezone: input.timezone ?? "UTC",
        status: input.status ?? "active",
        modelSelection: input.modelSelection,
        interactionMode: input.interactionMode,
        overlapPolicy: input.overlapPolicy,
        catchUp: input.catchUp,
        ...target,
        ...schedule,
      });
    }),
  automation_update: (input) =>
    Effect.gen(function* () {
      const scheduledTasks = yield* ScheduledTaskService;
      const task = yield* getAccessibleTask(ScheduledTaskId.make(input.id));
      return yield* scheduledTasks.update({
        id: ScheduledTaskId.make(input.id),
        patch: yield* buildUpdatePatch(input, task),
      });
    }),
  automation_delete: (input) =>
    Effect.gen(function* () {
      yield* getAccessibleTask(ScheduledTaskId.make(input.id));
      const scheduledTasks = yield* ScheduledTaskService;
      return yield* scheduledTasks.delete({ id: ScheduledTaskId.make(input.id) });
    }),
  automation_pause: (input) =>
    Effect.gen(function* () {
      yield* getAccessibleTask(ScheduledTaskId.make(input.id));
      const scheduledTasks = yield* ScheduledTaskService;
      return yield* scheduledTasks.pause({ id: ScheduledTaskId.make(input.id) });
    }),
  automation_resume: (input) =>
    Effect.gen(function* () {
      yield* getAccessibleTask(ScheduledTaskId.make(input.id));
      const scheduledTasks = yield* ScheduledTaskService;
      return yield* scheduledTasks.resume({ id: ScheduledTaskId.make(input.id) });
    }),
  automation_run_now: (input) =>
    Effect.gen(function* () {
      yield* getAccessibleTask(ScheduledTaskId.make(input.id));
      const scheduledTasks = yield* ScheduledTaskService;
      return yield* scheduledTasks.runNow({ id: ScheduledTaskId.make(input.id) });
    }),
} satisfies Parameters<typeof AutomationToolkit.toLayer>[0];

export const AutomationToolkitHandlersLive = AutomationToolkit.toLayer(handlers);

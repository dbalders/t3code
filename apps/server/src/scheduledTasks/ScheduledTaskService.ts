import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  ScheduledTaskError,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  ScheduledTaskId,
  type ScheduledTaskIdInput,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRun,
  ScheduledTaskRunId,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskRunsListInput,
  type ScheduledTaskRunsListResult,
  type ScheduledTasksListResult,
  type ScheduledTaskUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ScheduledTaskRepository,
  ScheduledTaskRunRepository,
} from "../persistence/Services/ScheduledTasks.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { computeNextRunAt, isOverdueByMoreThan } from "./Schedule.ts";

const MISSED_RUN_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function scheduledTaskError(message: string, cause?: unknown) {
  return new ScheduledTaskError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function fallbackModelSelection(): ModelSelection {
  return {
    instanceId: defaultInstanceIdForDriver(DEFAULT_PROVIDER_DRIVER_KIND),
    model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_DRIVER_KIND] ?? DEFAULT_MODEL,
  };
}

function isThreadBusy(thread: OrchestrationThreadShell): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

function pendingTurnStartFailed(thread: OrchestrationThreadShell): boolean {
  const session = thread.session;
  if (session === null) return false;
  if (
    session.status === "error" ||
    session.status === "stopped" ||
    session.status === "interrupted"
  ) {
    return true;
  }
  return (
    session.lastError !== null && session.status !== "starting" && session.status !== "running"
  );
}

function pendingTurnStartError(thread: OrchestrationThreadShell): string {
  return thread.session?.lastError ?? "Scheduled turn did not start.";
}

interface DispatchTarget {
  readonly project: OrchestrationProjectShell;
  readonly thread: OrchestrationThreadShell | null;
}

interface DispatchThread {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: NonNullable<ScheduledTask["runtimeMode"]>;
  readonly interactionMode: ScheduledTask["interactionMode"];
  readonly shouldCreateThread: boolean;
}

interface ScheduledTaskServiceShape {
  readonly list: () => Effect.Effect<ScheduledTasksListResult, ScheduledTaskError>;
  readonly create: (
    input: ScheduledTaskCreateInput,
  ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
  readonly update: (
    input: ScheduledTaskUpdateInput,
  ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
  readonly delete: (
    input: ScheduledTaskIdInput,
  ) => Effect.Effect<{ readonly id: ScheduledTaskId }, ScheduledTaskError>;
  readonly pause: (
    input: ScheduledTaskIdInput,
  ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
  readonly resume: (
    input: ScheduledTaskIdInput,
  ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
  readonly runNow: (
    input: ScheduledTaskRunNowInput,
  ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
  readonly listRuns: (
    input: ScheduledTaskRunsListInput,
  ) => Effect.Effect<ScheduledTaskRunsListResult, ScheduledTaskError>;
  readonly runDueTasks: () => Effect.Effect<void, ScheduledTaskError>;
  readonly reconcileOpenRuns: () => Effect.Effect<void, ScheduledTaskError>;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  ScheduledTaskServiceShape
>()("t3/scheduledTasks/ScheduledTaskService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const taskRepository = yield* ScheduledTaskRepository;
  const runRepository = yield* ScheduledTaskRunRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const randomUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => scheduledTaskError("Failed to generate identifier.", cause)),
  );
  const commandId = (tag: string) =>
    randomUuid.pipe(Effect.map((uuid) => CommandId.make(`scheduled-task:${tag}:${uuid}`)));
  const taskId = randomUuid.pipe(Effect.map(ScheduledTaskId.make));
  const runId = randomUuid.pipe(Effect.map(ScheduledTaskRunId.make));
  const threadId = randomUuid.pipe(Effect.map(ThreadId.make));
  const messageId = randomUuid.pipe(Effect.map(MessageId.make));

  const mapRepositoryError = (operation: string) => (cause: unknown) =>
    scheduledTaskError(`Scheduled task ${operation} failed.`, cause);

  const getProject = (projectId: ProjectId) =>
    projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError(mapRepositoryError("project lookup")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(scheduledTaskError("Project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const getExistingTask = (id: ScheduledTaskId) =>
    taskRepository.getById({ id }).pipe(
      Effect.mapError(mapRepositoryError("load")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(scheduledTaskError("Scheduled task was not found.")),
          onSome: (task) =>
            task.status === "deleted"
              ? Effect.fail(scheduledTaskError("Scheduled task was deleted."))
              : Effect.succeed(task),
        }),
      ),
    );

  const resolveTarget = (task: ScheduledTask): Effect.Effect<DispatchTarget, ScheduledTaskError> =>
    Effect.gen(function* () {
      const project = yield* getProject(task.projectId);
      if (task.kind === "standalone") {
        return { project, thread: null };
      }
      if (task.targetThreadId === null) {
        return yield* scheduledTaskError("Thread automations require a target thread.");
      }
      const thread = yield* projectionSnapshotQuery.getThreadShellById(task.targetThreadId).pipe(
        Effect.mapError(mapRepositoryError("thread lookup")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(scheduledTaskError("Target thread was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (thread.projectId !== task.projectId) {
        return yield* scheduledTaskError("Target thread does not belong to the selected project.");
      }
      return { project, thread };
    });

  const nextRunForStatus = (task: ScheduledTask, now: string) =>
    task.status === "active"
      ? computeNextRunAt(task, now, { inclusive: true })
      : Effect.succeed(null);

  const ensureRun = (task: ScheduledTask, scheduledFor: string, createdAt: string) =>
    Effect.gen(function* () {
      const existing = yield* runRepository
        .getByOccurrence({
          taskId: task.id,
          scheduledFor,
        })
        .pipe(Effect.mapError(mapRepositoryError("run lookup")));
      if (Option.isSome(existing)) {
        return existing.value;
      }
      const run: ScheduledTaskRun = {
        id: yield* runId,
        taskId: task.id,
        scheduledFor,
        status: "queued",
        threadId: null,
        messageId: null,
        turnId: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        resultSummary: null,
        createdAt,
        updatedAt: createdAt,
      };
      const inserted = yield* runRepository
        .insert(run)
        .pipe(Effect.mapError(mapRepositoryError("run create")));
      if (!inserted) {
        const claimed = yield* runRepository
          .getByOccurrence({
            taskId: task.id,
            scheduledFor,
          })
          .pipe(Effect.mapError(mapRepositoryError("claimed run lookup")));
        return yield* Option.match(claimed, {
          onNone: () =>
            Effect.fail(scheduledTaskError("Scheduled run occurrence could not be claimed.")),
          onSome: Effect.succeed,
        });
      }
      return run;
    });

  const updateRun = (run: ScheduledTaskRun) =>
    runRepository.upsert(run).pipe(Effect.mapError(mapRepositoryError("run update")));

  const getRunAfterLostClaim = (run: ScheduledTaskRun) =>
    runRepository.getById({ id: run.id }).pipe(
      Effect.mapError(mapRepositoryError("claimed run load")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(scheduledTaskError("Scheduled run claim disappeared.")),
          onSome: (currentRun) =>
            currentRun.status === "queued"
              ? Effect.fail(scheduledTaskError("Scheduled run could not be claimed."))
              : Effect.succeed(currentRun),
        }),
      ),
    );

  const claimRunForDispatch = (
    run: ScheduledTaskRun,
    threadId: ThreadId,
    userMessageId: MessageId,
    now: string,
  ) =>
    runRepository
      .claimQueued({
        id: run.id,
        threadId,
        messageId: userMessageId,
        startedAt: now,
        updatedAt: now,
      })
      .pipe(
        Effect.mapError(mapRepositoryError("run claim")),
        Effect.flatMap(
          Option.match({
            onNone: () => getRunAfterLostClaim(run),
            onSome: Effect.succeed,
          }),
        ),
      );

  const failRun = (run: ScheduledTaskRun, cause: unknown, now: string) => {
    const failedRun: ScheduledTaskRun = {
      ...run,
      status: "failure",
      finishedAt: now,
      error: cause instanceof Error ? cause.message : "Failed to dispatch scheduled run.",
      updatedAt: now,
    };
    return updateRun(failedRun).pipe(Effect.as(failedRun));
  };

  const advanceTask = (task: ScheduledTask, scheduledFor: string, now: string) =>
    computeNextRunAt(task, scheduledFor, { inclusive: false }).pipe(
      Effect.flatMap((nextRunAt) =>
        taskRepository.upsert({
          ...task,
          lastRunAt: scheduledFor,
          nextRunAt,
          updatedAt: now,
        }),
      ),
      Effect.mapError(mapRepositoryError("advance")),
    );

  const skipMissedRun = (task: ScheduledTask, run: ScheduledTaskRun, now: string) =>
    computeNextRunAt(task, now, { inclusive: false }).pipe(
      Effect.flatMap((nextRunAt) =>
        Effect.all([
          updateRun({
            ...run,
            status: "skipped",
            finishedAt: now,
            error: "Scheduled run was missed while the app was not running.",
            updatedAt: now,
          }),
          taskRepository.upsert({
            ...task,
            lastRunAt: run.scheduledFor,
            nextRunAt,
            updatedAt: now,
          }),
        ]),
      ),
      Effect.asVoid,
      Effect.mapError(mapRepositoryError("skip missed run")),
    );

  const prepareStandaloneThread = (task: ScheduledTask, target: DispatchTarget) =>
    Effect.gen(function* () {
      const createdThreadId = yield* threadId;
      const modelSelection =
        task.modelSelection ?? target.project.defaultModelSelection ?? fallbackModelSelection();
      return {
        threadId: createdThreadId,
        modelSelection,
        runtimeMode: task.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: task.interactionMode,
        shouldCreateThread: true,
      };
    });

  const prepareDispatchThread = (task: ScheduledTask, target: DispatchTarget) =>
    Effect.gen(function* () {
      if (target.thread === null) {
        return yield* prepareStandaloneThread(task, target);
      }
      return {
        threadId: target.thread.id,
        modelSelection: task.modelSelection ?? target.thread.modelSelection,
        runtimeMode: task.runtimeMode ?? target.thread.runtimeMode,
        interactionMode: task.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        shouldCreateThread: false,
      };
    });

  const dispatchPreparedRun = (
    task: ScheduledTask,
    dispatchThread: DispatchThread,
    userMessageId: MessageId,
    now: string,
  ) =>
    Effect.gen(function* () {
      if (dispatchThread.shouldCreateThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId: dispatchThread.threadId,
          projectId: task.projectId,
          title: task.name,
          modelSelection: dispatchThread.modelSelection,
          runtimeMode: dispatchThread.runtimeMode,
          interactionMode: dispatchThread.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("turn-start"),
        threadId: dispatchThread.threadId,
        message: {
          messageId: userMessageId,
          role: "user",
          text: task.prompt,
          attachments: [],
        },
        modelSelection: dispatchThread.modelSelection,
        runtimeMode: dispatchThread.runtimeMode,
        interactionMode: dispatchThread.interactionMode,
        titleSeed: task.name,
        createdAt: now,
      });
    });

  const dispatchRun = (task: ScheduledTask, run: ScheduledTaskRun, now: string) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(task);
      if (target.thread !== null && isThreadBusy(target.thread)) {
        const skippedRun = {
          ...run,
          status: "skipped" as const,
          finishedAt: now,
          error: "Target thread is already running a turn.",
          updatedAt: now,
        };
        yield* updateRun(skippedRun);
        return skippedRun;
      }

      const dispatchThread = yield* prepareDispatchThread(task, target);
      const userMessageId = yield* messageId;
      const runningRun = yield* claimRunForDispatch(
        run,
        dispatchThread.threadId,
        userMessageId,
        now,
      );
      if (runningRun.status !== "running" || runningRun.messageId !== userMessageId) {
        return runningRun;
      }
      return yield* dispatchPreparedRun(task, dispatchThread, userMessageId, now).pipe(
        Effect.matchEffect({
          onFailure: (cause) => failRun(runningRun, cause, now),
          onSuccess: () => Effect.succeed(runningRun),
        }),
      );
    }).pipe(Effect.catch((cause) => failRun(run, cause, now)));

  const runTaskOccurrence = (
    task: ScheduledTask,
    scheduledFor: string,
    options: { readonly advanceSchedule: boolean },
  ) =>
    Effect.gen(function* () {
      const startedAt = yield* nowIso;
      const run = yield* ensureRun(task, scheduledFor, startedAt);
      if (run.status !== "queued") {
        return run;
      }
      const dispatchedRun = yield* dispatchRun(task, run, startedAt);
      if (options.advanceSchedule) {
        yield* advanceTask(task, scheduledFor, startedAt);
      }
      return dispatchedRun;
    });

  const runDueTask = (task: ScheduledTask, now: string) =>
    Effect.gen(function* () {
      const scheduledFor = task.nextRunAt;
      if (scheduledFor === null) {
        return;
      }
      const run = yield* ensureRun(task, scheduledFor, now);
      if (run.status !== "queued") {
        yield* advanceTask(task, scheduledFor, now);
        return;
      }
      if (!task.catchUp && (yield* isOverdueByMoreThan(scheduledFor, now, MISSED_RUN_GRACE_MS))) {
        yield* skipMissedRun(task, run, now);
        return;
      }
      const dispatchedRun = yield* dispatchRun(task, run, now);
      if (dispatchedRun.status === "skipped") {
        yield* advanceTask(task, scheduledFor, now);
        return;
      }
      yield* advanceTask(task, scheduledFor, now);
    });

  const list: ScheduledTaskServiceShape["list"] = () =>
    taskRepository.listAll().pipe(
      Effect.map((tasks) => ({ tasks })),
      Effect.mapError(mapRepositoryError("list")),
    );

  const create: ScheduledTaskServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const task: ScheduledTask = {
        id: yield* taskId,
        name: input.name,
        kind: input.kind,
        projectId: input.projectId,
        targetThreadId: input.kind === "thread" ? (input.targetThreadId ?? null) : null,
        prompt: input.prompt,
        scheduleKind: input.scheduleKind,
        scheduleValue: input.scheduleValue,
        timezone: input.timezone,
        status: input.status ?? "active",
        modelSelection: input.modelSelection ?? null,
        runtimeMode: input.runtimeMode ?? null,
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        overlapPolicy: input.overlapPolicy ?? "skip",
        catchUp: input.catchUp ?? false,
        nextRunAt: null,
        lastRunAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      if (task.status === "deleted") {
        return yield* scheduledTaskError("New scheduled tasks cannot start deleted.");
      }
      yield* resolveTarget(task);
      const nextRunAt = yield* nextRunForStatus(task, createdAt);
      const savedTask = { ...task, nextRunAt };
      yield* taskRepository.upsert(savedTask).pipe(Effect.mapError(mapRepositoryError("create")));
      return { task: savedTask };
    });

  const update: ScheduledTaskServiceShape["update"] = ({ id, patch }) =>
    Effect.gen(function* () {
      const existing = yield* getExistingTask(id);
      const scheduleChanged =
        patch.scheduleKind !== undefined ||
        patch.scheduleValue !== undefined ||
        patch.timezone !== undefined;
      const statusChanged = patch.status !== undefined && patch.status !== existing.status;
      const updatedAt = yield* nowIso;
      const merged: ScheduledTask = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.scheduleKind !== undefined ? { scheduleKind: patch.scheduleKind } : {}),
        ...(patch.scheduleValue !== undefined ? { scheduleValue: patch.scheduleValue } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.modelSelection !== undefined ? { modelSelection: patch.modelSelection } : {}),
        ...(patch.runtimeMode !== undefined ? { runtimeMode: patch.runtimeMode } : {}),
        ...(patch.interactionMode !== undefined ? { interactionMode: patch.interactionMode } : {}),
        ...(patch.overlapPolicy !== undefined ? { overlapPolicy: patch.overlapPolicy } : {}),
        ...(patch.catchUp !== undefined ? { catchUp: patch.catchUp } : {}),
        targetThreadId:
          (patch.kind ?? existing.kind) === "standalone"
            ? null
            : patch.targetThreadId !== undefined
              ? patch.targetThreadId
              : existing.targetThreadId,
        updatedAt,
      };
      if (merged.status === "deleted") {
        return yield* scheduledTaskError("Use delete to remove a scheduled task.");
      }
      yield* resolveTarget(merged);
      const recomputedNextRunAt =
        scheduleChanged || statusChanged || existing.nextRunAt === null
          ? yield* computeNextRunAt(merged, updatedAt, { inclusive: true })
          : existing.nextRunAt;
      const nextRunAt = merged.status !== "active" ? null : recomputedNextRunAt;
      const savedTask = { ...merged, nextRunAt };
      yield* taskRepository.upsert(savedTask).pipe(Effect.mapError(mapRepositoryError("update")));
      return { task: savedTask };
    });

  const softDelete: ScheduledTaskServiceShape["delete"] = ({ id }) =>
    nowIso.pipe(
      Effect.flatMap((updatedAt) => taskRepository.softDelete({ id, updatedAt })),
      Effect.mapError(mapRepositoryError("delete")),
      Effect.as({ id }),
    );

  const pause: ScheduledTaskServiceShape["pause"] = ({ id }) =>
    update({ id, patch: { status: "paused" } });

  const resume: ScheduledTaskServiceShape["resume"] = ({ id }) =>
    update({ id, patch: { status: "active" } });

  const runNow: ScheduledTaskServiceShape["runNow"] = ({ id }) =>
    Effect.gen(function* () {
      const task = yield* getExistingTask(id);
      const scheduledFor = yield* nowIso;
      const run = yield* runTaskOccurrence(task, scheduledFor, { advanceSchedule: false });
      return { run };
    });

  const listRuns: ScheduledTaskServiceShape["listRuns"] = ({ taskId }) =>
    runRepository.listByTaskId({ taskId }).pipe(
      Effect.map((runs) => ({ runs })),
      Effect.mapError(mapRepositoryError("run list")),
    );

  const findRunTurn = (
    run: ScheduledTaskRun,
  ): Effect.Effect<ProjectionTurn | null, ScheduledTaskError> =>
    Effect.gen(function* () {
      if (run.threadId === null) return null;
      const turns = yield* projectionTurnRepository
        .listByThreadId({ threadId: run.threadId })
        .pipe(Effect.mapError(mapRepositoryError("open run turn lookup")));
      return (
        turns.find((turn) =>
          run.turnId !== null
            ? turn.turnId === run.turnId
            : run.messageId !== null && turn.pendingMessageId === run.messageId,
        ) ?? null
      );
    });

  const reconcileOpenRuns: ScheduledTaskServiceShape["reconcileOpenRuns"] = () =>
    Effect.gen(function* () {
      const openRuns = yield* runRepository
        .listOpen({})
        .pipe(Effect.mapError(mapRepositoryError("open run list")));
      yield* Effect.forEach(
        openRuns,
        (run) =>
          Effect.gen(function* () {
            if (run.threadId === null) return;
            const thread = yield* projectionSnapshotQuery
              .getThreadShellById(run.threadId)
              .pipe(
                Effect.mapError(mapRepositoryError("open run thread lookup")),
                Effect.map(Option.getOrNull),
              );
            if (thread === null) {
              yield* updateRun({
                ...run,
                status: "failure",
                finishedAt: yield* nowIso,
                error: "Thread no longer exists.",
                updatedAt: yield* nowIso,
              });
              return;
            }
            const turn = yield* findRunTurn(run);
            if (turn === null) return;
            if (turn.turnId === null) {
              if (!pendingTurnStartFailed(thread)) return;
              const updatedAt = yield* nowIso;
              yield* updateRun({
                ...run,
                status: "failure",
                startedAt: run.startedAt ?? turn.startedAt ?? turn.requestedAt,
                finishedAt: thread.session?.updatedAt ?? updatedAt,
                error: pendingTurnStartError(thread),
                updatedAt,
              });
              return;
            }
            const updatedAt = yield* nowIso;
            if (turn.state === "pending" || turn.state === "running") {
              yield* updateRun({
                ...run,
                status: "running",
                turnId: turn.turnId,
                startedAt: run.startedAt ?? turn.startedAt ?? turn.requestedAt,
                updatedAt,
              });
              return;
            }
            const status =
              turn.state === "completed"
                ? "success"
                : turn.state === "interrupted"
                  ? "canceled"
                  : "failure";
            yield* updateRun({
              ...run,
              status,
              turnId: turn.turnId,
              startedAt: run.startedAt ?? turn.startedAt ?? turn.requestedAt,
              finishedAt: turn.completedAt ?? updatedAt,
              error:
                turn.state === "error"
                  ? (thread.session?.lastError ?? "Scheduled turn ended with an error.")
                  : null,
              resultSummary: turn.state === "completed" ? "Turn completed." : null,
              updatedAt,
            });
          }),
        { concurrency: 4 },
      );
    });

  const runDueTasks: ScheduledTaskServiceShape["runDueTasks"] = () =>
    Effect.gen(function* () {
      yield* reconcileOpenRuns();
      const currentTime = yield* nowIso;
      const tasks = yield* taskRepository
        .listDue({ now: currentTime })
        .pipe(Effect.mapError(mapRepositoryError("due task list")));
      yield* Effect.forEach(
        tasks,
        (task) =>
          runDueTask(task, currentTime).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("scheduled task execution failed", {
                taskId: task.id,
                cause,
              }),
            ),
          ),
        { concurrency: 1 },
      );
    });

  return {
    list,
    create,
    update,
    delete: softDelete,
    pause,
    resume,
    runNow,
    listRuns,
    runDueTasks,
    reconcileOpenRuns,
  } satisfies ScheduledTaskServiceShape;
});

export const ScheduledTaskServiceLive = Layer.effect(ScheduledTaskService, make);

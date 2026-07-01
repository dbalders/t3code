import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  ScheduledTaskRunId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import {
  ScheduledTaskRepositoryLive,
  ScheduledTaskRunRepositoryLive,
} from "../persistence/Layers/ScheduledTasks.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  ScheduledTaskRepository,
  ScheduledTaskRunRepository,
} from "../persistence/Services/ScheduledTasks.ts";
import { ScheduledTaskService, ScheduledTaskServiceLive } from "./ScheduledTaskService.ts";

const projectId = ProjectId.make("project-scheduled");
const taskId = ScheduledTaskId.make("task-due");
const scheduledFor = "1969-12-31T17:00:00.000Z";
const now = "1969-12-31T00:00:00.000Z";
const defaultProviderDriverKind = ProviderDriverKind.make("codex");
const defaultProviderInstanceId = defaultInstanceIdForDriver(defaultProviderDriverKind);
const modelSelection = {
  instanceId: defaultProviderInstanceId,
  model: DEFAULT_MODEL_BY_PROVIDER[defaultProviderDriverKind] ?? DEFAULT_MODEL,
};
const explicitAutomationModelSelection = {
  instanceId: defaultProviderInstanceId,
  model: "scheduled-model",
  options: [{ id: "reasoningEffort", value: "xhigh" }],
};

const projectShell: OrchestrationProjectShell = {
  id: projectId,
  title: "Scheduled Project",
  workspaceRoot: "/tmp/scheduled-project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};

const dueStandaloneTask: ScheduledTask = {
  id: taskId,
  name: "Daily check",
  kind: "standalone",
  projectId,
  targetThreadId: null,
  prompt: "Summarize the project status.",
  scheduleKind: "once",
  scheduleValue: scheduledFor,
  timezone: "America/Los_Angeles",
  status: "active",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  overlapPolicy: "skip",
  catchUp: true,
  nextRunAt: scheduledFor,
  lastRunAt: null,
  createdAt: now,
  updatedAt: now,
};

const missingProjectTask: ScheduledTask = {
  ...dueStandaloneTask,
  id: ScheduledTaskId.make("task-missing-project"),
  projectId: ProjectId.make("project-missing"),
};

const unused = (name: string) => Effect.die(`${name} was not expected in this test`);

function makeTestLayer(
  commandsRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  options?: {
    readonly failTurnStart?: boolean;
    readonly threadShells?: ReadonlyMap<string, OrchestrationThreadShell>;
  },
) {
  const scheduledTaskPersistenceLayer = Layer.mergeAll(
    ProjectionTurnRepositoryLive,
    ScheduledTaskRepositoryLive,
    ScheduledTaskRunRepositoryLive,
  );
  const orchestrationLayer = Layer.mock(OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Ref.modify(commandsRef, (commands) => [
        { sequence: commands.length + 1 },
        [...commands, command],
      ]).pipe(
        Effect.flatMap((result) =>
          options?.failTurnStart === true && command.type === "thread.turn.start"
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Injected scheduled turn dispatch failure.",
                }),
              )
            : Effect.succeed(result),
        ),
      ),
    streamDomainEvents: Stream.empty,
  });
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getCommandReadModel: () => unused("getCommandReadModel"),
    getSnapshot: () => unused("getSnapshot"),
    getShellSnapshot: () => unused("getShellSnapshot"),
    getArchivedShellSnapshot: () => unused("getArchivedShellSnapshot"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: (requestedProjectId) =>
      Effect.succeed(requestedProjectId === projectId ? Option.some(projectShell) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: (threadId) => {
      const thread = options?.threadShells?.get(String(threadId));
      return Effect.succeed(thread ? Option.some(thread) : Option.none());
    },
    getThreadDetailById: () => Effect.succeed(Option.none()),
  });

  return ScheduledTaskServiceLive.pipe(
    Layer.provideMerge(scheduledTaskPersistenceLayer),
    Layer.provide(orchestrationLayer),
    Layer.provide(projectionLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ScheduledTaskService", () => {
  it.effect("validates patched schedules even when the task is paused", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const pausedTask: ScheduledTask = {
        ...dueStandaloneTask,
        status: "paused",
        nextRunAt: null,
      };
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(pausedTask);
        const error = yield* scheduledTasks
          .update({
            id: pausedTask.id,
            patch: { scheduleKind: "rrule" },
          })
          .pipe(Effect.flip);

        assert.match(error.message, /RRULE schedule value/);
        const { tasks } = yield* scheduledTasks.list();
        assert.equal(tasks[0]?.scheduleKind, "once");
        assert.equal(tasks[0]?.scheduleValue, pausedTask.scheduleValue);
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef)));
    }),
  );

  it.effect("keeps soft-deleted tasks available to list filters", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(dueStandaloneTask);
        yield* scheduledTasks.delete({ id: dueStandaloneTask.id });

        const { tasks } = yield* scheduledTasks.list();
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.id, dueStandaloneTask.id);
        assert.equal(tasks[0]?.status, "deleted");
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef)));
    }),
  );

  it.effect("dispatches a due standalone task through orchestration and records the run", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(dueStandaloneTask);
        const beforeRun = yield* scheduledTasks.list();
        assert.equal(beforeRun.tasks.length, 1);
        assert.equal(beforeRun.tasks[0]?.nextRunAt, scheduledFor);
        yield* scheduledTasks.runDueTasks();

        const commands = yield* Ref.get(commandsRef);
        assert.equal(commands.length, 2);
        assert.equal(commands[0]?.type, "thread.create");
        assert.equal(commands[1]?.type, "thread.turn.start");
        if (commands[1]?.type !== "thread.turn.start") {
          return yield* Effect.die("Expected thread.turn.start command.");
        }
        assert.equal(commands[1].message.text, dueStandaloneTask.prompt);
        assert.equal(commands[1].titleSeed, dueStandaloneTask.name);

        const { runs } = yield* scheduledTasks.listRuns({ taskId });
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.status, "running");
        assert.equal(runs[0]?.scheduledFor, scheduledFor);
        assert.equal(runs[0]?.threadId, commands[1].threadId);
        assert.equal(runs[0]?.messageId, commands[1].message.messageId);
        assert.equal(runs[0]?.turnId, null);

        const { tasks } = yield* scheduledTasks.list();
        assert.equal(tasks[0]?.lastRunAt, scheduledFor);
        assert.equal(tasks[0]?.nextRunAt, null);
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef)));
    }),
  );

  it.effect("uses explicit model selections for standalone scheduled runs", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const taskWithModel: ScheduledTask = {
        ...dueStandaloneTask,
        modelSelection: explicitAutomationModelSelection,
      };
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(taskWithModel);
        yield* scheduledTasks.runDueTasks();

        const commands = yield* Ref.get(commandsRef);
        assert.equal(commands.length, 2);
        assert.equal(commands[0]?.type, "thread.create");
        assert.equal(commands[1]?.type, "thread.turn.start");
        if (commands[0]?.type !== "thread.create" || commands[1]?.type !== "thread.turn.start") {
          return yield* Effect.die("Expected scheduled standalone dispatch.");
        }
        assert.deepEqual(commands[0].modelSelection, explicitAutomationModelSelection);
        assert.deepEqual(commands[1].modelSelection, explicitAutomationModelSelection);
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef)));
    }),
  );

  it.effect("uses explicit model selections instead of the target thread model", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const targetThreadId = ThreadId.make("thread-scheduled-target");
      const taskWithThreadOverride: ScheduledTask = {
        ...dueStandaloneTask,
        kind: "thread",
        targetThreadId,
        modelSelection: explicitAutomationModelSelection,
      };
      const threadShell: OrchestrationThreadShell = {
        id: targetThreadId,
        projectId,
        title: "Scheduled Thread",
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      };
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(taskWithThreadOverride);
        yield* scheduledTasks.runDueTasks();

        const commands = yield* Ref.get(commandsRef);
        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.type, "thread.turn.start");
        if (commands[0]?.type !== "thread.turn.start") {
          return yield* Effect.die("Expected scheduled thread dispatch.");
        }
        assert.equal(commands[0].threadId, targetThreadId);
        assert.deepEqual(commands[0].modelSelection, explicitAutomationModelSelection);
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(commandsRef, {
            threadShells: new Map([[String(targetThreadId), threadShell]]),
          }),
        ),
      );
    }),
  );

  it.effect("persists dispatch identifiers before starting the scheduled turn", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(dueStandaloneTask);
        yield* scheduledTasks.runDueTasks();

        const commands = yield* Ref.get(commandsRef);
        assert.equal(commands.length, 2);
        assert.equal(commands[0]?.type, "thread.create");
        assert.equal(commands[1]?.type, "thread.turn.start");

        const { runs } = yield* scheduledTasks.listRuns({ taskId });
        assert.equal(runs.length, 1);
        const run = runs[0];
        assert.equal(run?.status, "failure");
        assert.equal(
          run?.threadId,
          commands[0]?.type === "thread.create" ? commands[0].threadId : null,
        );
        assert.equal(
          run?.messageId,
          commands[1]?.type === "thread.turn.start" ? commands[1].message.messageId : null,
        );
        assert.notEqual(run?.startedAt, null);
        assert.equal(run?.finishedAt, run?.startedAt);
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef, { failTurnStart: true })));
    }),
  );

  it.effect("fails and advances a due run when the target project is stale", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(missingProjectTask);
        yield* scheduledTasks.runDueTasks();

        const commands = yield* Ref.get(commandsRef);
        assert.equal(commands.length, 0);

        const { runs } = yield* scheduledTasks.listRuns({ taskId: missingProjectTask.id });
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.status, "failure");
        assert.match(runs[0]?.error ?? "", /Project was not found/);

        const { tasks } = yield* scheduledTasks.list();
        assert.equal(tasks[0]?.lastRunAt, missingProjectTask.nextRunAt);
        assert.equal(tasks[0]?.nextRunAt, null);
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef)));
    }),
  );

  it.effect("continues polling other due tasks after one task fails", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const invalidTask: ScheduledTask = {
        ...dueStandaloneTask,
        id: ScheduledTaskId.make("task-a-invalid-schedule"),
        scheduleKind: "rrule",
        scheduleValue: "not-json",
      };
      const validTask: ScheduledTask = {
        ...dueStandaloneTask,
        id: ScheduledTaskId.make("task-b-valid-schedule"),
        prompt: "Run after the invalid task.",
      };
      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(invalidTask);
        yield* taskRepository.upsert(validTask);
        yield* scheduledTasks.runDueTasks();

        const commands = yield* Ref.get(commandsRef);
        assert.equal(commands.length, 4);
        assert.equal(commands[3]?.type, "thread.turn.start");
        if (commands[3]?.type !== "thread.turn.start") {
          return yield* Effect.die("Expected valid task to dispatch a turn.");
        }
        assert.equal(commands[3].message.text, validTask.prompt);

        const { runs } = yield* scheduledTasks.listRuns({ taskId: validTask.id });
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.status, "running");
      });

      yield* program.pipe(Effect.provide(makeTestLayer(commandsRef)));
    }),
  );

  it.effect("reconciles provider start failures before a turn id exists", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const threadId = ThreadId.make("thread-start-failed");
      const messageId = MessageId.make("message-start-failed");
      const failedAt = "1969-12-31T17:01:00.000Z";
      const threadShell: OrchestrationThreadShell = {
        id: threadId,
        projectId,
        title: "Scheduled Thread",
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: failedAt,
        archivedAt: null,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: "Provider session failed before turn start.",
          updatedAt: failedAt,
        },
        latestUserMessageAt: scheduledFor,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      };

      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const runRepository = yield* ScheduledTaskRunRepository;
        const turnRepository = yield* ProjectionTurnRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(dueStandaloneTask);
        yield* runRepository.upsert({
          id: ScheduledTaskRunId.make("run-start-failed"),
          taskId,
          scheduledFor,
          status: "running",
          threadId,
          messageId,
          turnId: null,
          startedAt: scheduledFor,
          finishedAt: null,
          error: null,
          resultSummary: null,
          createdAt: scheduledFor,
          updatedAt: scheduledFor,
        });
        yield* turnRepository.replacePendingTurnStart({
          threadId,
          messageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: scheduledFor,
        });

        yield* scheduledTasks.reconcileOpenRuns();

        const { runs } = yield* scheduledTasks.listRuns({ taskId });
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.status, "failure");
        assert.equal(runs[0]?.turnId, null);
        assert.equal(runs[0]?.finishedAt, failedAt);
        assert.equal(runs[0]?.error, "Provider session failed before turn start.");
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(commandsRef, {
            threadShells: new Map([[String(threadId), threadShell]]),
          }),
        ),
      );
    }),
  );

  it.effect("reconciles a completed scheduled turn even after a newer turn becomes latest", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const threadId = ThreadId.make("thread-completed-run");
      const messageId = MessageId.make("message-scheduled-run");
      const turnId = TurnId.make("turn-scheduled-run");
      const newerTurnId = TurnId.make("turn-newer");
      const completedAt = "1969-12-31T17:05:00.000Z";
      const threadShell: OrchestrationThreadShell = {
        id: threadId,
        projectId,
        title: "Scheduled Thread",
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: newerTurnId,
          state: "running",
          requestedAt: "1969-12-31T17:06:00.000Z",
          startedAt: "1969-12-31T17:06:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        createdAt: now,
        updatedAt: completedAt,
        archivedAt: null,
        session: null,
        latestUserMessageAt: scheduledFor,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      };

      const program = Effect.gen(function* () {
        const taskRepository = yield* ScheduledTaskRepository;
        const runRepository = yield* ScheduledTaskRunRepository;
        const turnRepository = yield* ProjectionTurnRepository;
        const scheduledTasks = yield* ScheduledTaskService;

        yield* taskRepository.upsert(dueStandaloneTask);
        yield* runRepository.upsert({
          id: ScheduledTaskRunId.make("run-completed"),
          taskId,
          scheduledFor,
          status: "running",
          threadId,
          messageId,
          turnId: null,
          startedAt: scheduledFor,
          finishedAt: null,
          error: null,
          resultSummary: null,
          createdAt: scheduledFor,
          updatedAt: scheduledFor,
        });
        yield* turnRepository.upsertByTurnId({
          turnId,
          threadId,
          pendingMessageId: messageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "completed",
          requestedAt: scheduledFor,
          startedAt: scheduledFor,
          completedAt,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });

        yield* scheduledTasks.reconcileOpenRuns();

        const { runs } = yield* scheduledTasks.listRuns({ taskId });
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.status, "success");
        assert.equal(runs[0]?.turnId, turnId);
        assert.equal(runs[0]?.finishedAt, completedAt);
        assert.equal(runs[0]?.resultSummary, "Turn completed.");
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(commandsRef, {
            threadShells: new Map([[String(threadId), threadShell]]),
          }),
        ),
      );
    }),
  );
});

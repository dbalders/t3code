import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskRRuleConfig,
  ScheduledTaskRunId,
  type ScheduledTaskCreateInput,
  type ScheduledTaskUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { AutomationToolkitHandlersLive } from "./handlers.ts";
import { AutomationToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-automation-tools-test");
const threadId = ThreadId.make("thread-automation-tools-test");
const otherProjectId = ProjectId.make("project-automation-tools-other");
const otherThreadId = ThreadId.make("thread-automation-tools-other");
const taskId = ScheduledTaskId.make("task-automation-tools-test");
const now = "2026-06-20T00:00:00.000Z";
const rruleConfigStringSchema = Schema.fromJsonString(ScheduledTaskRRuleConfig);
const encodeRRuleConfig = Schema.encodeSync(rruleConfigStringSchema);
const decodeRRuleConfig = Schema.decodeUnknownSync(rruleConfigStringSchema);

const invocation = {
  environmentId: EnvironmentId.make("environment-automation-tools-test"),
  threadId,
  providerSessionId: "provider-session-automation-tools-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["automations"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "automation-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const makeTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: taskId,
  name: "Automation test task",
  kind: "thread",
  projectId,
  targetThreadId: threadId,
  prompt: "Check this thread for stale follow-ups.",
  scheduleKind: "once",
  scheduleValue: "2026-06-21T16:00:00.000Z",
  timezone: "UTC",
  status: "active",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  overlapPolicy: "skip",
  catchUp: false,
  nextRunAt: "2026-06-21T16:00:00.000Z",
  lastRunAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const makeThreadShell = (
  id: ThreadId,
  shellProjectId: ProjectId,
  title = "Automation test thread",
) => ({
  id,
  projectId: shellProjectId,
  title,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
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
});

type ScheduledTaskServiceTestService = ReturnType<typeof ScheduledTaskService.of>;
type ProjectionSnapshotQueryTestShape = Parameters<typeof ProjectionSnapshotQuery.of>[0];
type ProjectionSnapshotQueryTestService = ReturnType<typeof ProjectionSnapshotQuery.of>;

const makeProjectionSnapshotQuery = (
  overrides: Partial<ProjectionSnapshotQueryTestShape> = {},
): ProjectionSnapshotQueryTestService =>
  ProjectionSnapshotQuery.of({
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: (targetThreadId) =>
      Effect.succeed(
        targetThreadId === threadId
          ? Option.some(makeThreadShell(threadId, projectId))
          : targetThreadId === otherThreadId
            ? Option.some(makeThreadShell(otherThreadId, otherProjectId, "Other thread"))
            : Option.none(),
      ),
    getThreadDetailById: () => Effect.die("unused"),
    ...overrides,
  });

const makeTestLayer = (
  scheduledTasks: ScheduledTaskServiceTestService,
  projectionSnapshotQuery = makeProjectionSnapshotQuery(),
) =>
  McpServer.toolkit(AutomationToolkit).pipe(
    Layer.provide(AutomationToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(ScheduledTaskService, scheduledTasks)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
  );

it.effect("creates automations for the calling thread by default", () => {
  let capturedCreate: ScheduledTaskCreateInput | null = null;

  const scheduledTasks = ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    create: (input) => {
      capturedCreate = input;
      return Effect.succeed({
        task: {
          id: taskId,
          name: input.name,
          kind: input.kind,
          projectId: input.projectId,
          targetThreadId: input.targetThreadId ?? null,
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
          nextRunAt: input.scheduleValue,
          lastRunAt: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    },
    update: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    runNow: () =>
      Effect.succeed({
        run: {
          id: ScheduledTaskRunId.make("run-unused"),
          taskId,
          scheduledFor: now,
          status: "queued",
          threadId: null,
          messageId: null,
          turnId: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          resultSummary: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    listRuns: () => Effect.succeed({ runs: [] }),
    runDueTasks: () => Effect.void,
    reconcileOpenRuns: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "automation_create",
          arguments: {
            prompt: "Check this thread for stale follow-ups.",
            scheduleKind: "once",
            runAt: "2026-06-21T09:00:00-07:00",
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(capturedCreate).toMatchObject({
        kind: "thread",
        projectId,
        targetThreadId: threadId,
        prompt: "Check this thread for stale follow-ups.",
        scheduleKind: "once",
        timezone: "UTC",
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(scheduledTasks)));
});

it.effect("hides deleted automations from list results by default", () => {
  const activeTask = makeTask();
  const deletedTask = makeTask({
    id: ScheduledTaskId.make("task-automation-tools-deleted"),
    status: "deleted",
  });

  const scheduledTasks = ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [activeTask, deletedTask] }),
    create: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    runNow: () => Effect.die("unused"),
    listRuns: () => Effect.succeed({ runs: [] }),
    runDueTasks: () => Effect.void,
    reconcileOpenRuns: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const defaultResult = yield* server
        .callTool({ name: "automation_list", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(defaultResult.isError).toBe(false);
      expect(defaultResult.structuredContent).toMatchObject({
        tasks: [expect.objectContaining({ id: taskId, status: "active" })],
      });

      const allResult = yield* server
        .callTool({ name: "automation_list", arguments: { status: "all" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(allResult.isError).toBe(false);
      expect(allResult.structuredContent).toMatchObject({
        tasks: [
          expect.objectContaining({ id: taskId, status: "active" }),
          expect.objectContaining({ id: deletedTask.id, status: "deleted" }),
        ],
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(scheduledTasks)));
});

it.effect("only lists automations accessible from the calling chat", () => {
  const activeTask = makeTask();
  const otherThreadTask = makeTask({
    id: ScheduledTaskId.make("task-automation-tools-other-thread"),
    targetThreadId: otherThreadId,
  });
  const otherProjectStandaloneTask = makeTask({
    id: ScheduledTaskId.make("task-automation-tools-other-standalone"),
    kind: "standalone",
    projectId: otherProjectId,
    targetThreadId: null,
  });
  const currentProjectStandaloneTask = makeTask({
    id: ScheduledTaskId.make("task-automation-tools-project-standalone"),
    kind: "standalone",
    targetThreadId: null,
  });

  const scheduledTasks = ScheduledTaskService.of({
    list: () =>
      Effect.succeed({
        tasks: [
          activeTask,
          otherThreadTask,
          otherProjectStandaloneTask,
          currentProjectStandaloneTask,
        ],
      }),
    create: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    runNow: () => Effect.die("unused"),
    listRuns: () => Effect.succeed({ runs: [] }),
    runDueTasks: () => Effect.void,
    reconcileOpenRuns: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "automation_list", arguments: { status: "all" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        tasks: [
          expect.objectContaining({ id: activeTask.id }),
          expect.objectContaining({ id: currentProjectStandaloneTask.id }),
        ],
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(scheduledTasks)));
});

it.effect("rejects mutations for automations outside the calling chat scope", () => {
  let deleteCalled = false;
  const inaccessibleTask = makeTask({
    id: ScheduledTaskId.make("task-automation-tools-inaccessible-delete"),
    targetThreadId: otherThreadId,
  });

  const scheduledTasks = ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [inaccessibleTask] }),
    create: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    delete: () => {
      deleteCalled = true;
      return Effect.die("delete should not be called");
    },
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    runNow: () => Effect.die("unused"),
    listRuns: () => Effect.succeed({ runs: [] }),
    runDueTasks: () => Effect.void,
    reconcileOpenRuns: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "automation_delete", arguments: { id: inaccessibleTask.id } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(deleteCalled).toBe(false);
    }),
  ).pipe(Effect.provide(makeTestLayer(scheduledTasks)));
});

it.effect("preserves existing recurrence fields during partial schedule updates", () => {
  const existingTask = makeTask({
    scheduleKind: "rrule",
    scheduleValue: encodeRRuleConfig({
      frequency: "weekly",
      interval: 1,
      dtStart: "2026-06-22T16:00:00.000Z",
      byDay: ["MO", "WE"],
      count: 5,
    }),
  });
  let capturedUpdate: ScheduledTaskUpdateInput | null = null;

  const scheduledTasks = ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [existingTask] }),
    create: () => Effect.die("unused"),
    update: (input) => {
      capturedUpdate = input;
      return Effect.succeed({
        task: {
          ...existingTask,
          scheduleKind: input.patch.scheduleKind ?? existingTask.scheduleKind,
          scheduleValue: input.patch.scheduleValue ?? existingTask.scheduleValue,
          updatedAt: now,
        },
      });
    },
    delete: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    runNow: () => Effect.die("unused"),
    listRuns: () => Effect.succeed({ runs: [] }),
    runDueTasks: () => Effect.void,
    reconcileOpenRuns: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "automation_update",
          arguments: {
            id: existingTask.id,
            interval: 2,
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(capturedUpdate?.patch.scheduleKind).toBe("rrule");
      expect(capturedUpdate?.patch.scheduleValue).toBeDefined();
      const config = decodeRRuleConfig(capturedUpdate!.patch.scheduleValue);
      expect(config).toMatchObject({
        frequency: "weekly",
        interval: 2,
        dtStart: "2026-06-22T16:00:00.000Z",
        byDay: ["MO", "WE"],
        count: 5,
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(scheduledTasks)));
});

it.effect("infers one-time schedule updates from runAt even for existing recurrence tasks", () => {
  const existingTask = makeTask({
    scheduleKind: "rrule",
    scheduleValue: encodeRRuleConfig({
      frequency: "weekly",
      interval: 1,
      dtStart: "2026-06-22T16:00:00.000Z",
    }),
  });
  let capturedUpdate: ScheduledTaskUpdateInput | null = null;

  const scheduledTasks = ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [existingTask] }),
    create: () => Effect.die("unused"),
    update: (input) => {
      capturedUpdate = input;
      return Effect.succeed({
        task: {
          ...existingTask,
          scheduleKind: input.patch.scheduleKind ?? existingTask.scheduleKind,
          scheduleValue: input.patch.scheduleValue ?? existingTask.scheduleValue,
          updatedAt: now,
        },
      });
    },
    delete: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    resume: () => Effect.die("unused"),
    runNow: () => Effect.die("unused"),
    listRuns: () => Effect.succeed({ runs: [] }),
    runDueTasks: () => Effect.void,
    reconcileOpenRuns: () => Effect.void,
  });

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "automation_update",
          arguments: {
            id: existingTask.id,
            runAt: "2026-07-01T09:00:00-07:00",
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(false);
      expect(capturedUpdate?.patch).toMatchObject({
        scheduleKind: "once",
        scheduleValue: "2026-07-01T16:00:00.000Z",
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(scheduledTasks)));
});

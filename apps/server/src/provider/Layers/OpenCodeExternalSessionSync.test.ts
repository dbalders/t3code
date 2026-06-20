import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_OPENCODE_MODEL,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OrchestrationLayerLive } from "../../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type {
  OpenCodeAdapterShape,
  OpenCodeExternalSessionSummary,
} from "../Services/OpenCodeAdapter.ts";
import { OpenCodeExternalSessionSync } from "../Services/OpenCodeExternalSessionSync.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import {
  externalThreadIdForOpenCodeSession,
  makeOpenCodeExternalSessionSyncLive,
  matchOpenCodeSessionToProject,
} from "./OpenCodeExternalSessionSync.ts";

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const CREATED_AT = "2026-06-19T12:00:00.000Z";
const KNOWN_PROJECT_ROOT = "/tmp/t3-code-known-project";

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeSession(input: {
  readonly sessionId: string;
  readonly directory: string;
  readonly title?: string | undefined;
  readonly updatedAtEpochMs?: number | undefined;
  readonly archivedAtEpochMs?: number | undefined;
  readonly model?: OpenCodeExternalSessionSummary["model"] | undefined;
}): OpenCodeExternalSessionSummary {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    title: input.title ?? `OpenCode ${input.sessionId}`,
    model: input.model,
    createdAtEpochMs: Date.parse("2026-06-19T10:00:00.000Z"),
    updatedAtEpochMs: input.updatedAtEpochMs ?? Date.parse("2026-06-19T11:00:00.000Z"),
    ...(input.archivedAtEpochMs !== undefined
      ? { archivedAtEpochMs: input.archivedAtEpochMs }
      : {}),
  };
}

function makeFakeOpenCodeAdapter(input: {
  readonly sessions: ReadonlyArray<OpenCodeExternalSessionSummary>;
  readonly calls: Array<ReadonlyArray<string>>;
}): OpenCodeAdapterShape {
  return {
    provider: OPENCODE_DRIVER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: unsupported,
    sendTurn: unsupported,
    interruptTurn: unsupported,
    respondToRequest: unsupported,
    respondToUserInput: unsupported,
    stopSession: unsupported,
    listSessions: () => Effect.succeed([]),
    listExternalSessions: ({ directories }) =>
      Effect.sync(() => {
        input.calls.push([...directories]);
        return input.sessions;
      }),
    hasSession: () => Effect.succeed(false),
    readThread: unsupported,
    rollbackThread: unsupported,
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

function makeFakeProviderInstance(adapter: OpenCodeAdapterShape): ProviderInstance {
  return {
    instanceId: OPENCODE_INSTANCE_ID,
    driverKind: OPENCODE_DRIVER,
    continuationIdentity: {
      driverKind: OPENCODE_DRIVER,
      continuationKey: `${OPENCODE_DRIVER}:instance:${OPENCODE_INSTANCE_ID}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}

function makeHarnessLayer(sessions: ReadonlyArray<OpenCodeExternalSessionSummary>) {
  const calls: Array<ReadonlyArray<string>> = [];
  const adapter = makeFakeOpenCodeAdapter({ sessions, calls });
  const instance = makeFakeProviderInstance(adapter);
  const registryLayer = Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === OPENCODE_INSTANCE_ID ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die(new Error("unused")),
  });
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provideMerge(ProviderSessionRuntimeRepositoryLive),
  );
  const layer = makeOpenCodeExternalSessionSyncLive({
    syncIntervalMs: 1_000,
    sessionListLimit: 50,
  }).pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(providerSessionDirectoryLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode-sync-test-" })),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    calls,
    layer,
  };
}

function createProject(projectId: ProjectId, workspaceRoot: string) {
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`project-create-${projectId}`),
      projectId,
      title: "Known Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: OPENCODE_INSTANCE_ID,
        model: DEFAULT_OPENCODE_MODEL,
      },
      createdAt: CREATED_AT,
    });
  });
}

describe("OpenCodeExternalSessionSync", () => {
  it.effect("matches sessions only to active project roots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const project = {
        projectId: ProjectId.make("project-known"),
        title: "Known",
        workspaceRoot: KNOWN_PROJECT_ROOT,
        defaultModelSelection: null,
        scripts: [],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        deletedAt: null,
      };
      const deletedProject = {
        ...project,
        projectId: ProjectId.make("project-deleted"),
        workspaceRoot: "/tmp/deleted-project",
        deletedAt: CREATED_AT,
      };

      expect(
        matchOpenCodeSessionToProject(path, [project], `${KNOWN_PROJECT_ROOT}/src`)?.projectId,
      ).toBe(project.projectId);
      expect(
        matchOpenCodeSessionToProject(path, [project], "/tmp/t3-code-known-project-sibling"),
      ).toBe(undefined);
      expect(matchOpenCodeSessionToProject(path, [deletedProject], "/tmp/deleted-project")).toBe(
        undefined,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "imports external OpenCode sessions for known projects and filters unknown/T3-owned sessions",
    () => {
      const projectId = ProjectId.make("project-known-opencode");
      const sessions = [
        makeSession({
          sessionId: "session-known-root",
          directory: KNOWN_PROJECT_ROOT,
          title: "Root external session",
          model: { providerID: "ucsd", id: "api-deepseek-v4-flash" },
        }),
        makeSession({
          sessionId: "session-known-child",
          directory: `${KNOWN_PROJECT_ROOT}/packages/app`,
          title: "Child external session",
        }),
        makeSession({
          sessionId: "session-unknown",
          directory: "/tmp/not-added-to-t3",
          title: "Unknown project session",
        }),
        makeSession({
          sessionId: "session-t3-owned",
          directory: KNOWN_PROJECT_ROOT,
          title: `TritonAI Code ${ThreadId.make("existing-t3-thread")}`,
        }),
      ];
      const harness = makeHarnessLayer(sessions);
      return Effect.gen(function* () {
        yield* createProject(projectId, KNOWN_PROJECT_ROOT);
        const sync = yield* OpenCodeExternalSessionSync;
        const result = yield* sync.syncOnce;
        expect(result).toMatchObject({
          discoveredCount: 4,
          importedCount: 2,
          skippedCount: 2,
          failedInstanceCount: 0,
        });

        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getShellSnapshot();
        const importedThreads = snapshot.threads.filter((thread) => thread.projectId === projectId);
        expect(importedThreads.map((thread) => thread.title).sort()).toEqual([
          "Child external session",
          "Root external session",
        ]);
        expect(importedThreads.every((thread) => thread.session?.status === "stopped")).toBe(true);
        expect(
          importedThreads.every((thread) => thread.session?.providerName === OPENCODE_DRIVER),
        ).toBe(true);

        const rootThreadId = externalThreadIdForOpenCodeSession({
          instanceId: OPENCODE_INSTANCE_ID,
          sessionId: "session-known-root",
        });
        const rootThread = importedThreads.find((thread) => thread.id === rootThreadId);
        expect(rootThread?.modelSelection).toEqual({
          instanceId: OPENCODE_INSTANCE_ID,
          model: "ucsd/api-deepseek-v4-flash",
        });
        expect(rootThread?.worktreePath).toBeNull();

        const childThreadId = externalThreadIdForOpenCodeSession({
          instanceId: OPENCODE_INSTANCE_ID,
          sessionId: "session-known-child",
        });
        const childThread = importedThreads.find((thread) => thread.id === childThreadId);
        expect(childThread?.worktreePath).toBe(`${KNOWN_PROJECT_ROOT}/packages/app`);

        const directory = yield* ProviderSessionDirectory;
        const binding = yield* directory.getBinding(rootThreadId);
        expect(Option.getOrUndefined(binding)?.resumeCursor).toEqual({
          sessionID: "session-known-root",
        });
        expect(harness.calls).toEqual([[KNOWN_PROJECT_ROOT]]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("is idempotent across repeated syncs", () => {
    const projectId = ProjectId.make("project-idempotent-opencode");
    const harness = makeHarnessLayer([
      makeSession({
        sessionId: "session-repeat",
        directory: KNOWN_PROJECT_ROOT,
        title: "Repeat session",
      }),
    ]);
    return Effect.gen(function* () {
      yield* createProject(projectId, KNOWN_PROJECT_ROOT);
      const sync = yield* OpenCodeExternalSessionSync;
      const first = yield* sync.syncOnce;
      const second = yield* sync.syncOnce;
      expect(first.importedCount).toBe(1);
      expect(second.importedCount).toBe(0);
      expect(second.refreshedCount).toBe(1);

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const importedThreads = snapshot.threads.filter((thread) => thread.projectId === projectId);
      expect(importedThreads).toHaveLength(1);
      expect(importedThreads[0]?.id).toBe(
        externalThreadIdForOpenCodeSession({
          instanceId: OPENCODE_INSTANCE_ID,
          sessionId: "session-repeat",
        }),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refreshes stopped imported thread metadata from OpenCode", () => {
    const projectId = ProjectId.make("project-metadata-refresh-opencode");
    const sessions = [
      makeSession({
        sessionId: "session-metadata-refresh",
        directory: KNOWN_PROJECT_ROOT,
        title: "Initial title",
      }),
    ];
    const harness = makeHarnessLayer(sessions);
    return Effect.gen(function* () {
      yield* createProject(projectId, KNOWN_PROJECT_ROOT);
      const sync = yield* OpenCodeExternalSessionSync;
      const first = yield* sync.syncOnce;
      expect(first.importedCount).toBe(1);

      sessions[0] = makeSession({
        sessionId: "session-metadata-refresh",
        directory: KNOWN_PROJECT_ROOT,
        title: "Updated OpenCode title",
        updatedAtEpochMs: Date.parse("2026-06-19T11:05:00.000Z"),
        model: { providerID: "ucsd", id: "api-deepseek-v4-flash" },
      });
      const second = yield* sync.syncOnce;
      expect(second.importedCount).toBe(0);
      expect(second.refreshedCount).toBe(1);

      const threadId = externalThreadIdForOpenCodeSession({
        instanceId: OPENCODE_INSTANCE_ID,
        sessionId: "session-metadata-refresh",
      });
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const importedThread = snapshot.threads.find((thread) => thread.id === threadId);
      expect(importedThread?.title).toBe("Updated OpenCode title");
      expect(importedThread?.modelSelection).toEqual({
        instanceId: OPENCODE_INSTANCE_ID,
        model: "ucsd/api-deepseek-v4-flash",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not refresh an imported session while its provider binding is active", () => {
    const projectId = ProjectId.make("project-active-opencode");
    const session = makeSession({
      sessionId: "session-active",
      directory: KNOWN_PROJECT_ROOT,
      title: "Active imported session",
    });
    const harness = makeHarnessLayer([session]);
    return Effect.gen(function* () {
      yield* createProject(projectId, KNOWN_PROJECT_ROOT);
      const sync = yield* OpenCodeExternalSessionSync;
      const first = yield* sync.syncOnce;
      expect(first.importedCount).toBe(1);

      const threadId = externalThreadIdForOpenCodeSession({
        instanceId: OPENCODE_INSTANCE_ID,
        sessionId: "session-active",
      });
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId,
        provider: OPENCODE_DRIVER,
        providerInstanceId: OPENCODE_INSTANCE_ID,
        adapterKey: OPENCODE_DRIVER,
        runtimeMode: "full-access",
        status: "running",
        resumeCursor: { sessionID: "session-active" },
        runtimePayload: {
          cwd: KNOWN_PROJECT_ROOT,
          externalOpenCodeSessionId: "session-active",
        },
      });
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`mark-running-${threadId}`),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: OPENCODE_DRIVER,
          providerInstanceId: OPENCODE_INSTANCE_ID,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: CREATED_AT,
        },
        createdAt: CREATED_AT,
      });

      const second = yield* sync.syncOnce;
      expect(second.importedCount).toBe(0);
      expect(second.refreshedCount).toBe(0);
      expect(second.skippedCount).toBe(1);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      expect(binding?.status).toBe("running");
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const importedThread = snapshot.threads.find((thread) => thread.id === threadId);
      expect(importedThread?.session?.status).toBe("running");
    }).pipe(Effect.provide(harness.layer));
  });
});

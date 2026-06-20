import { createHash } from "node:crypto";

import {
  CommandId,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import type { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type {
  OpenCodeAdapterShape,
  OpenCodeExternalSessionSummary,
} from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeExternalSessionSync,
  type OpenCodeExternalSessionSyncResult,
  type OpenCodeExternalSessionSyncShape,
} from "../Services/OpenCodeExternalSessionSync.ts";

const OPENCODE_PROVIDER = ProviderDriverKind.make("opencode");
const T3_OWNED_SESSION_TITLE_PREFIX = "TritonAI Harness ";
const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const DEFAULT_SESSION_LIST_LIMIT = 200;

export interface OpenCodeExternalSessionSyncLiveOptions {
  readonly syncIntervalMs?: number | undefined;
  readonly sessionListLimit?: number | undefined;
}

interface DiscoverySuccess {
  readonly failed: false;
  readonly instance: ProviderInstance;
  readonly sessions: ReadonlyArray<OpenCodeExternalSessionSummary>;
}

interface DiscoveryFailure {
  readonly failed: true;
  readonly instance: ProviderInstance;
}

type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

const emptyResult: OpenCodeExternalSessionSyncResult = {
  discoveredCount: 0,
  importedCount: 0,
  refreshedCount: 0,
  skippedCount: 0,
  failedInstanceCount: 0,
};

export function normalizeWorkspacePath(path: Path.Path, input: string): string {
  const trimmed = input.trim();
  return trimmed.length === 0 ? "" : path.resolve(trimmed);
}

export function isPathAtOrInsideRoot(
  path: Path.Path,
  candidatePath: string,
  rootPath: string,
): boolean {
  const candidate = normalizeWorkspacePath(path, candidatePath);
  const root = normalizeWorkspacePath(path, rootPath);
  if (candidate.length === 0 || root.length === 0) {
    return false;
  }
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function matchOpenCodeSessionToProject(
  path: Path.Path,
  projects: ReadonlyArray<ProjectionProject>,
  sessionDirectory: string,
): ProjectionProject | undefined {
  const activeProjects = projects
    .filter((project) => project.deletedAt === null)
    .map((project) => ({
      project,
      normalizedRoot: normalizeWorkspacePath(path, project.workspaceRoot),
    }))
    .filter((entry) => entry.normalizedRoot.length > 0)
    .sort((left, right) => right.normalizedRoot.length - left.normalizedRoot.length);

  return activeProjects.find((entry) =>
    isPathAtOrInsideRoot(path, sessionDirectory, entry.normalizedRoot),
  )?.project;
}

export function isT3OwnedOpenCodeSession(session: OpenCodeExternalSessionSummary): boolean {
  return session.title.startsWith(T3_OWNED_SESSION_TITLE_PREFIX);
}

export function externalThreadIdForOpenCodeSession(input: {
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
}): ThreadId {
  const digest = createHash("sha256")
    .update(`${input.instanceId}\0${input.sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return ThreadId.make(`opencode-external-${digest}`);
}

function externalThreadCreateCommandId(threadId: ThreadId): CommandId {
  return CommandId.make(`opencode-external-create-${threadId}`);
}

function externalThreadSessionCommandId(
  threadId: ThreadId,
  session: OpenCodeExternalSessionSummary,
): CommandId {
  return CommandId.make(`opencode-external-session-${threadId}-${session.updatedAtEpochMs}`);
}

function externalThreadMetaCommandId(
  threadId: ThreadId,
  session: OpenCodeExternalSessionSummary,
  modelSelection: ModelSelection,
): CommandId {
  const digest = createHash("sha256")
    .update(session.directory)
    .update("\0")
    .update(session.title)
    .update("\0")
    .update(JSON.stringify(modelSelection))
    .digest("hex")
    .slice(0, 16);
  return CommandId.make(`opencode-external-meta-${threadId}-${session.updatedAtEpochMs}-${digest}`);
}

function epochMsToIso(epochMs: number, fallback: string): string {
  if (!Number.isFinite(epochMs)) {
    return fallback;
  }
  return Option.match(DateTime.make(epochMs), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
  });
}

function titleForExternalSession(session: OpenCodeExternalSessionSummary): string {
  const trimmed = session.title.trim();
  return trimmed.length > 0 ? trimmed : "OpenCode session";
}

function worktreePathForExternalSession(input: {
  readonly path: Path.Path;
  readonly project: ProjectionProject;
  readonly session: OpenCodeExternalSessionSummary;
}): string | null {
  const projectRoot = normalizeWorkspacePath(input.path, input.project.workspaceRoot);
  const sessionDirectory = normalizeWorkspacePath(input.path, input.session.directory);
  return sessionDirectory.length === 0 || sessionDirectory === projectRoot
    ? null
    : sessionDirectory;
}

function modelSelectionForExternalSession(input: {
  readonly session: OpenCodeExternalSessionSummary;
  readonly project: ProjectionProject;
  readonly instanceId: ProviderInstanceId;
}): ModelSelection {
  const providerID = input.session.model?.providerID.trim() ?? "";
  const modelID = input.session.model?.id.trim() ?? "";
  const model =
    providerID.length > 0 && modelID.length > 0
      ? `${providerID}/${modelID}`
      : input.project.defaultModelSelection?.instanceId === input.instanceId
        ? input.project.defaultModelSelection.model
        : DEFAULT_OPENCODE_MODEL;
  return {
    instanceId: input.instanceId,
    model,
  };
}

function isOpenCodeDiscoveryAdapter(
  adapter: ProviderInstance["adapter"],
): adapter is OpenCodeAdapterShape {
  return typeof (adapter as Partial<OpenCodeAdapterShape>).listExternalSessions === "function";
}

const makeOpenCodeExternalSessionSync = (options?: OpenCodeExternalSessionSyncLiveOptions) =>
  Effect.gen(function* () {
    const providerInstances = yield* ProviderInstanceRegistry;
    const projectRepository = yield* ProjectionProjectRepository;
    const threadRepository = yield* ProjectionThreadRepository;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const sessionDirectory = yield* ProviderSessionDirectory;
    const path = yield* Path.Path;
    const syncIntervalMs = Math.max(1, options?.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
    const sessionListLimit = Math.max(1, options?.sessionListLimit ?? DEFAULT_SESSION_LIST_LIMIT);

    const importExternalSession = Effect.fn("importExternalSession")(function* (input: {
      readonly instance: ProviderInstance;
      readonly project: ProjectionProject;
      readonly session: OpenCodeExternalSessionSummary;
      readonly now: string;
    }) {
      const threadId = externalThreadIdForOpenCodeSession({
        instanceId: input.instance.instanceId,
        sessionId: input.session.sessionId,
      });
      const modelSelection = modelSelectionForExternalSession({
        session: input.session,
        project: input.project,
        instanceId: input.instance.instanceId,
      });
      const createdAt = epochMsToIso(input.session.createdAtEpochMs, input.now);
      const updatedAt = epochMsToIso(input.session.updatedAtEpochMs, createdAt);
      const title = titleForExternalSession(input.session);
      const existingThread = yield* threadRepository.getById({ threadId });
      const existingProjectionThread = Option.getOrUndefined(existingThread);
      if (existingProjectionThread !== undefined && existingProjectionThread.deletedAt !== null) {
        return "skipped" as const;
      }
      const existingBinding = Option.getOrUndefined(yield* sessionDirectory.getBinding(threadId));
      if (
        existingProjectionThread !== undefined &&
        existingBinding?.status !== undefined &&
        existingBinding.status !== "stopped"
      ) {
        return "skipped" as const;
      }
      const desiredWorktreePath = worktreePathForExternalSession({
        path,
        project: input.project,
        session: input.session,
      });

      if (existingProjectionThread === undefined) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: externalThreadCreateCommandId(threadId),
          threadId,
          projectId: input.project.projectId,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: desiredWorktreePath,
          createdAt,
        });
      } else {
        const metadataUpdate: {
          title?: string;
          modelSelection?: ModelSelection;
          worktreePath?: string | null;
        } = {};
        if (existingProjectionThread.title !== title) {
          metadataUpdate.title = title;
        }
        if (!Equal.equals(existingProjectionThread.modelSelection, modelSelection)) {
          metadataUpdate.modelSelection = modelSelection;
        }
        if (existingProjectionThread.worktreePath !== desiredWorktreePath) {
          metadataUpdate.worktreePath = desiredWorktreePath;
        }
        if (Object.keys(metadataUpdate).length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: externalThreadMetaCommandId(threadId, input.session, modelSelection),
            threadId,
            ...metadataUpdate,
          });
        }
      }

      yield* sessionDirectory.upsert({
        threadId,
        provider: OPENCODE_PROVIDER,
        providerInstanceId: input.instance.instanceId,
        adapterKey: OPENCODE_PROVIDER,
        runtimeMode: "full-access",
        status: "stopped",
        resumeCursor: { sessionID: input.session.sessionId },
        runtimePayload: {
          cwd: input.session.directory,
          model: modelSelection.model,
          modelSelection,
          externalOpenCodeSessionId: input.session.sessionId,
        },
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: externalThreadSessionCommandId(threadId, input.session),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: OPENCODE_PROVIDER,
          providerInstanceId: input.instance.instanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt,
        },
        createdAt: updatedAt,
      });

      return existingProjectionThread === undefined
        ? ("imported" as const)
        : ("refreshed" as const);
    });

    const runSyncOnce = Effect.gen(function* () {
      const projects = (yield* projectRepository.listAll()).filter(
        (project) =>
          project.deletedAt === null &&
          normalizeWorkspacePath(path, project.workspaceRoot).length > 0,
      );
      if (projects.length === 0) {
        return emptyResult;
      }

      const directories = [...new Set(projects.map((project) => project.workspaceRoot))];
      const instances = (yield* providerInstances.listInstances).filter(
        (instance) =>
          instance.enabled &&
          instance.driverKind === OPENCODE_PROVIDER &&
          isOpenCodeDiscoveryAdapter(instance.adapter),
      );
      if (instances.length === 0) {
        return emptyResult;
      }

      const discoveries = yield* Effect.forEach(
        instances,
        (instance): Effect.Effect<DiscoveryResult> =>
          (instance.adapter as OpenCodeAdapterShape)
            .listExternalSessions({
              directories,
              limit: sessionListLimit,
            })
            .pipe(
              Effect.map(
                (sessions): DiscoverySuccess => ({
                  failed: false,
                  instance,
                  sessions,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("opencode.external-session-sync.discovery-failed", {
                  instanceId: instance.instanceId,
                  detail: Cause.pretty(cause),
                  cause,
                }).pipe(
                  Effect.as({
                    failed: true,
                    instance,
                  } satisfies DiscoveryFailure),
                ),
              ),
            ),
        { concurrency: 1 },
      );

      let discoveredCount = 0;
      let importedCount = 0;
      let refreshedCount = 0;
      let skippedCount = 0;

      for (const discovery of discoveries) {
        if (discovery.failed) {
          continue;
        }
        for (const session of discovery.sessions) {
          discoveredCount += 1;
          const project = matchOpenCodeSessionToProject(path, projects, session.directory);
          if (
            project === undefined ||
            session.archivedAtEpochMs !== undefined ||
            isT3OwnedOpenCodeSession(session)
          ) {
            skippedCount += 1;
            continue;
          }

          const now = DateTime.formatIso(yield* DateTime.now);
          const status = yield* importExternalSession({
            instance: discovery.instance,
            project,
            session,
            now,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("opencode.external-session-sync.import-failed", {
                instanceId: discovery.instance.instanceId,
                sessionId: session.sessionId,
                directory: session.directory,
                detail: Cause.pretty(cause),
                cause,
              }).pipe(Effect.as("skipped" as const)),
            ),
          );

          switch (status) {
            case "imported":
              importedCount += 1;
              break;
            case "refreshed":
              refreshedCount += 1;
              break;
            case "skipped":
              skippedCount += 1;
              break;
          }
        }
      }

      return {
        discoveredCount,
        importedCount,
        refreshedCount,
        skippedCount,
        failedInstanceCount: discoveries.filter((discovery) => discovery.failed).length,
      } satisfies OpenCodeExternalSessionSyncResult;
    });

    const syncOnce = runSyncOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("opencode.external-session-sync.failed", {
          detail: Cause.pretty(cause),
          cause,
        }).pipe(Effect.as(emptyResult)),
      ),
    );

    const start: OpenCodeExternalSessionSyncShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          syncOnce.pipe(
            Effect.tap((result) =>
              result.importedCount > 0 ||
              result.refreshedCount > 0 ||
              result.failedInstanceCount > 0
                ? Effect.logInfo("opencode.external-session-sync.completed", result)
                : Effect.void,
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(syncIntervalMs))),
          ),
        );
        yield* Effect.logInfo("opencode.external-session-sync.started", {
          syncIntervalMs,
          sessionListLimit,
        });
      });

    return {
      syncOnce,
      start,
    } satisfies OpenCodeExternalSessionSyncShape;
  });

export const makeOpenCodeExternalSessionSyncLive = (
  options?: OpenCodeExternalSessionSyncLiveOptions,
) => Layer.effect(OpenCodeExternalSessionSync, makeOpenCodeExternalSessionSync(options));

export const OpenCodeExternalSessionSyncLive = makeOpenCodeExternalSessionSyncLive();

import { pathToFileURL } from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_DATABASE_LOCKED_RETRY_DELAYS = ["250 millis", "750 millis", "1500 millis"] as const;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

interface SharedOpenCodeServerEntry {
  readonly server: OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  readonly refCount: number;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export function isOpenCodeDatabaseLockedError(cause: unknown): boolean {
  return openCodeRuntimeErrorDetail(cause).toLowerCase().includes("database is locked");
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function openCodeLocalServerLockKey(input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}): string {
  const environment = buildOpenCodeServerEnvironment(input.environment ?? process.env);
  const dataScope =
    nonEmptyEnvironmentValue(environment.XDG_DATA_HOME) ??
    nonEmptyEnvironmentValue(environment.HOME) ??
    nonEmptyEnvironmentValue(environment.USERPROFILE) ??
    nonEmptyEnvironmentValue(environment.XDG_STATE_HOME) ??
    nonEmptyEnvironmentValue(environment.OPENCODE_CONFIG) ??
    input.binaryPath;

  return `opencode-local-server:${dataScope}`;
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeSkill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly content: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly reuseLocalServer?: boolean;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

export function buildOpenCodeServerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (typeof environment.OPENCODE_CONFIG === "string" && environment.OPENCODE_CONFIG.trim()) {
    const { OPENCODE_CONFIG_CONTENT: _content, ...withoutInlineConfig } = environment;
    return withoutInlineConfig;
  }

  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT:
      typeof environment.OPENCODE_CONFIG_CONTENT === "string"
        ? environment.OPENCODE_CONFIG_CONTENT
        : OPENCODE_EMPTY_CONFIG_CONTENT,
  };
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const runtimeScope = yield* Effect.scope;
  const localServerLocksRef = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
  const sharedLocalServersRef = yield* Ref.make<ReadonlyMap<string, SharedOpenCodeServerEntry>>(
    new Map(),
  );
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const getLocalServerLock = Effect.fn("getOpenCodeLocalServerLock")(function* (lockKey: string) {
    const existing = (yield* Ref.get(localServerLocksRef)).get(lockKey);
    if (existing) {
      return existing;
    }

    const lock = yield* Semaphore.make(1);
    return yield* Ref.modify(localServerLocksRef, (locks) => {
      const current = locks.get(lockKey);
      if (current) {
        return [current, locks] as const;
      }
      const next = new Map(locks);
      next.set(lockKey, lock);
      return [lock, next] as const;
    });
  });

  const removeSharedLocalServer = (
    lockKey: string,
    server: OpenCodeServerProcess,
  ): Effect.Effect<SharedOpenCodeServerEntry | null> =>
    Ref.modify(sharedLocalServersRef, (servers) => {
      const current = servers.get(lockKey);
      if (!current || current.server !== server) {
        return [null, servers] as const;
      }
      const next = new Map(servers);
      next.delete(lockKey);
      return [current, next] as const;
    });

  const releaseSharedLocalServer = (
    lockKey: string,
    server: OpenCodeServerProcess,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const lock = yield* getLocalServerLock(lockKey);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const scopeToClose = yield* Ref.modify(sharedLocalServersRef, (servers) => {
            const current = servers.get(lockKey);
            if (!current || current.server !== server) {
              return [null, servers] as const;
            }
            if (current.refCount > 1) {
              const next = new Map(servers);
              next.set(lockKey, { ...current, refCount: current.refCount - 1 });
              return [null, next] as const;
            }
            const next = new Map(servers);
            next.delete(lockKey);
            return [current.scope, next] as const;
          });
          if (scopeToClose) {
            yield* Scope.close(scopeToClose, Exit.void).pipe(Effect.ignore);
          }
        }),
      );
    });

  const tryAcquireExclusiveLocalServerLock = Effect.fn(
    "tryAcquireOpenCodeExclusiveLocalServerLock",
  )(function* (lockKey: string, exclusiveScope: Scope.Closeable) {
    const lock = yield* getLocalServerLock(lockKey);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(lock.take(1));
        const existing = (yield* Ref.get(sharedLocalServersRef)).get(lockKey);
        if (existing) {
          yield* lock.release(1);
          return false;
        }
        yield* Scope.addFinalizer(exclusiveScope, lock.release(1));
        return true;
      }),
    );
  });

  const acquireExclusiveLocalServerLock = Effect.fn("acquireOpenCodeExclusiveLocalServerLock")(
    function* (lockKey: string, exclusiveScope: Scope.Closeable) {
      while (true) {
        const acquired = yield* tryAcquireExclusiveLocalServerLock(lockKey, exclusiveScope);
        if (acquired) {
          return;
        }
        const existing = (yield* Ref.get(sharedLocalServersRef)).get(lockKey);
        if (existing) {
          yield* existing.server.exitCode.pipe(Effect.timeoutOption("100 millis"), Effect.ignore);
        } else {
          yield* Effect.sleep("100 millis");
        }
      }
    },
  );

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startOpenCodeServerProcessOnce: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (
    input,
  ) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: buildOpenCodeServerEnvironment(input.environment ?? process.env),
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseServerUrlFromOutput(nextStdout);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      // Startup-time fibers are no longer needed once ready has resolved (either
      // way). The exit fiber is only interrupted on failure; on success it keeps
      // the caller's `exitCode` effect observable until the scope closes.
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        yield* terminateChild;
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        yield* terminateChild;
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      return {
        url: readyOption.value,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const startOpenCodeServerProcessWithRetry = (
    input: Parameters<OpenCodeRuntimeShape["startOpenCodeServerProcess"]>[0],
    attempt = 0,
  ): ReturnType<OpenCodeRuntimeShape["startOpenCodeServerProcess"]> =>
    startOpenCodeServerProcessOnce(input).pipe(
      Effect.catch((cause: OpenCodeRuntimeError) => {
        const retryDelay = OPENCODE_DATABASE_LOCKED_RETRY_DELAYS[attempt];
        if (!retryDelay || !isOpenCodeDatabaseLockedError(cause)) {
          return Effect.fail(cause);
        }
        return Effect.logWarning(
          `OpenCode server startup hit a locked database; retrying in ${retryDelay}.`,
        ).pipe(
          Effect.andThen(Effect.sleep(retryDelay)),
          Effect.andThen(startOpenCodeServerProcessWithRetry(input, attempt + 1)),
        );
      }),
    );

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    startOpenCodeServerProcessWithRetry(input);

  const retainSharedLocalServer = (
    input: Omit<Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0], "serverUrl">,
  ): Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope> => {
    const lockKey = openCodeLocalServerLockKey({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });

    return Effect.gen(function* () {
      const callerScope = yield* Scope.Scope;
      const lock = yield* getLocalServerLock(lockKey);

      return yield* lock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const existing = (yield* Ref.get(sharedLocalServersRef)).get(lockKey);
            if (existing) {
              const exited = yield* existing.server.exitCode.pipe(Effect.timeoutOption("1 millis"));
              if (Option.isNone(exited)) {
                yield* Ref.update(sharedLocalServersRef, (servers) => {
                  const current = servers.get(lockKey);
                  if (!current || current.server !== existing.server) {
                    return servers;
                  }
                  const next = new Map(servers);
                  next.set(lockKey, { ...current, refCount: current.refCount + 1 });
                  return next;
                });
                yield* Scope.addFinalizer(
                  callerScope,
                  releaseSharedLocalServer(lockKey, existing.server),
                );
                return {
                  url: existing.server.url,
                  exitCode: existing.server.exitCode,
                  external: false,
                } satisfies OpenCodeServerConnection;
              }

              yield* removeSharedLocalServer(lockKey, existing.server);
              yield* Scope.close(existing.scope, Exit.void).pipe(Effect.ignore);
            }

            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  ...(input.environment !== undefined ? { environment: input.environment } : {}),
                  ...(input.port !== undefined ? { port: input.port } : {}),
                  ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
                  ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                }).pipe(Effect.provideService(Scope.Scope, serverScope)),
              ),
            );

            if (Exit.isFailure(startedExit)) {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            const server = startedExit.value;
            yield* Ref.update(sharedLocalServersRef, (servers) => {
              const next = new Map(servers);
              next.set(lockKey, { server, scope: serverScope, refCount: 1 });
              return next;
            });

            const exitMonitor = yield* server.exitCode.pipe(
              Effect.flatMap(() => lock.withPermits(1)(removeSharedLocalServer(lockKey, server))),
              Effect.flatMap((removed) =>
                removed ? Scope.close(removed.scope, Exit.void).pipe(Effect.ignore) : Effect.void,
              ),
              Effect.ignore,
              Effect.forkIn(runtimeScope),
            );
            yield* Scope.addFinalizer(
              serverScope,
              Fiber.interrupt(exitMonitor).pipe(Effect.ignore),
            );
            yield* Scope.addFinalizer(callerScope, releaseSharedLocalServer(lockKey, server));

            return {
              url: server.url,
              exitCode: server.exitCode,
              external: false,
            } satisfies OpenCodeServerConnection;
          }),
        ),
      );
    });
  };

  const retainExclusiveLocalServer = (
    input: Omit<
      Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0],
      "serverUrl" | "reuseLocalServer"
    >,
  ): Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope> => {
    const lockKey = openCodeLocalServerLockKey({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });

    return Effect.gen(function* () {
      const exclusiveScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void).pipe(Effect.ignore),
      );
      yield* acquireExclusiveLocalServerLock(lockKey, exclusiveScope);

      const serverScope = yield* Scope.make();
      yield* Scope.addFinalizer(
        exclusiveScope,
        Scope.close(serverScope, Exit.void).pipe(Effect.ignore),
      );
      const server = yield* startOpenCodeServerProcess({
        binaryPath: input.binaryPath,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }).pipe(Effect.provideService(Scope.Scope, serverScope));

      return {
        url: server.url,
        exitCode: server.exitCode,
        external: false,
      } satisfies OpenCodeServerConnection;
    });
  };

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      // We don't own externally-configured servers — no scope interaction.
      return Effect.succeed({
        url: serverUrl,
        exitCode: null,
        external: true,
      });
    }

    if (input.reuseLocalServer === false) {
      return retainExclusiveLocalServer({
        binaryPath: input.binaryPath,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
    }

    return retainSharedLocalServer({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadSkills = (client: OpencodeClient) =>
    runOpenCodeSdk("app.skills", () => client.app.skills()).pipe(
      Effect.map((result) => (result.data ?? []) as ReadonlyArray<OpenCodeSkill>),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client), loadSkills(client)], {
      concurrency: "unbounded",
    }).pipe(Effect.map(([providerList, agents, skills]) => ({ providerList, agents, skills })));

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);

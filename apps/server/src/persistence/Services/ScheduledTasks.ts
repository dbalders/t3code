import {
  IsoDateTime,
  MessageId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskRun,
  ScheduledTaskRunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ScheduledTaskRepositoryError } from "../Errors.ts";

export const GetScheduledTaskInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type GetScheduledTaskInput = typeof GetScheduledTaskInput.Type;

export const ListDueScheduledTasksInput = Schema.Struct({
  now: IsoDateTime,
});
export type ListDueScheduledTasksInput = typeof ListDueScheduledTasksInput.Type;

export const DeleteScheduledTaskInput = Schema.Struct({
  id: ScheduledTaskId,
  updatedAt: IsoDateTime,
});
export type DeleteScheduledTaskInput = typeof DeleteScheduledTaskInput.Type;

export const ListScheduledTaskRunsInput = Schema.Struct({
  taskId: ScheduledTaskId,
});
export type ListScheduledTaskRunsInput = typeof ListScheduledTaskRunsInput.Type;

export const ListOpenScheduledTaskRunsInput = Schema.Struct({});
export type ListOpenScheduledTaskRunsInput = typeof ListOpenScheduledTaskRunsInput.Type;

export const GetScheduledTaskRunInput = Schema.Struct({
  id: ScheduledTaskRunId,
});
export type GetScheduledTaskRunInput = typeof GetScheduledTaskRunInput.Type;

export const GetScheduledTaskRunByOccurrenceInput = Schema.Struct({
  taskId: ScheduledTaskId,
  scheduledFor: IsoDateTime,
});
export type GetScheduledTaskRunByOccurrenceInput = typeof GetScheduledTaskRunByOccurrenceInput.Type;

export const ClaimScheduledTaskRunInput = Schema.Struct({
  id: ScheduledTaskRunId,
  threadId: ThreadId,
  messageId: MessageId,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ClaimScheduledTaskRunInput = typeof ClaimScheduledTaskRunInput.Type;

export interface ScheduledTaskRepositoryShape {
  readonly upsert: (task: ScheduledTask) => Effect.Effect<void, ScheduledTaskRepositoryError>;
  readonly getById: (
    input: GetScheduledTaskInput,
  ) => Effect.Effect<Option.Option<ScheduledTask>, ScheduledTaskRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskRepositoryError>;
  readonly listDue: (
    input: ListDueScheduledTasksInput,
  ) => Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskRepositoryError>;
  readonly softDelete: (
    input: DeleteScheduledTaskInput,
  ) => Effect.Effect<void, ScheduledTaskRepositoryError>;
}

export interface ScheduledTaskRunRepositoryShape {
  readonly upsert: (run: ScheduledTaskRun) => Effect.Effect<void, ScheduledTaskRepositoryError>;
  readonly insert: (run: ScheduledTaskRun) => Effect.Effect<boolean, ScheduledTaskRepositoryError>;
  readonly getById: (
    input: GetScheduledTaskRunInput,
  ) => Effect.Effect<Option.Option<ScheduledTaskRun>, ScheduledTaskRepositoryError>;
  readonly getByOccurrence: (
    input: GetScheduledTaskRunByOccurrenceInput,
  ) => Effect.Effect<Option.Option<ScheduledTaskRun>, ScheduledTaskRepositoryError>;
  readonly claimQueued: (
    input: ClaimScheduledTaskRunInput,
  ) => Effect.Effect<Option.Option<ScheduledTaskRun>, ScheduledTaskRepositoryError>;
  readonly listByTaskId: (
    input: ListScheduledTaskRunsInput,
  ) => Effect.Effect<ReadonlyArray<ScheduledTaskRun>, ScheduledTaskRepositoryError>;
  readonly listOpen: (
    input: ListOpenScheduledTaskRunsInput,
  ) => Effect.Effect<ReadonlyArray<ScheduledTaskRun>, ScheduledTaskRepositoryError>;
}

export class ScheduledTaskRepository extends Context.Service<
  ScheduledTaskRepository,
  ScheduledTaskRepositoryShape
>()("t3/persistence/Services/ScheduledTasks/ScheduledTaskRepository") {}

export class ScheduledTaskRunRepository extends Context.Service<
  ScheduledTaskRunRepository,
  ScheduledTaskRunRepositoryShape
>()("t3/persistence/Services/ScheduledTasks/ScheduledTaskRunRepository") {}

import { ModelSelection, ScheduledTask, ScheduledTaskRun } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteScheduledTaskInput,
  GetScheduledTaskInput,
  GetScheduledTaskRunByOccurrenceInput,
  GetScheduledTaskRunInput,
  ListOpenScheduledTaskRunsInput,
  ListDueScheduledTasksInput,
  ListScheduledTaskRunsInput,
  ScheduledTaskRepository,
  ScheduledTaskRunRepository,
  type ScheduledTaskRepositoryShape,
  type ScheduledTaskRunRepositoryShape,
} from "../Services/ScheduledTasks.ts";

const ScheduledTaskDbRow = ScheduledTask.mapFields(
  Struct.assign({
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    catchUp: Schema.Number,
  }),
);
type ScheduledTaskDbRow = typeof ScheduledTaskDbRow.Type;

function toScheduledTask(row: ScheduledTaskDbRow): ScheduledTask {
  return {
    ...row,
    catchUp: row.catchUp === 1,
  };
}

const makeScheduledTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertTaskRow = SqlSchema.void({
    Request: ScheduledTask,
    execute: (task) =>
      sql`
        INSERT INTO scheduled_tasks (
          task_id,
          name,
          kind,
          project_id,
          target_thread_id,
          prompt,
          schedule_kind,
          schedule_value,
          timezone,
          status,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          overlap_policy,
          catch_up,
          next_run_at,
          last_run_at,
          created_at,
          updated_at
        )
        VALUES (
          ${task.id},
          ${task.name},
          ${task.kind},
          ${task.projectId},
          ${task.targetThreadId},
          ${task.prompt},
          ${task.scheduleKind},
          ${task.scheduleValue},
          ${task.timezone},
          ${task.status},
          ${task.modelSelection !== null ? JSON.stringify(task.modelSelection) : null},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.overlapPolicy},
          ${task.catchUp ? 1 : 0},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.createdAt},
          ${task.updatedAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          project_id = excluded.project_id,
          target_thread_id = excluded.target_thread_id,
          prompt = excluded.prompt,
          schedule_kind = excluded.schedule_kind,
          schedule_value = excluded.schedule_value,
          timezone = excluded.timezone,
          status = excluded.status,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          overlap_policy = excluded.overlap_policy,
          catch_up = excluded.catch_up,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          updated_at = excluded.updated_at
      `,
  });

  const getTaskRowById = SqlSchema.findOneOption({
    Request: GetScheduledTaskInput,
    Result: ScheduledTaskDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          task_id AS "id",
          name,
          kind,
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          prompt,
          schedule_kind AS "scheduleKind",
          schedule_value AS "scheduleValue",
          timezone,
          status,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          overlap_policy AS "overlapPolicy",
          catch_up AS "catchUp",
          next_run_at AS "nextRunAt",
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_tasks
        WHERE task_id = ${id}
      `,
  });

  const listTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ScheduledTaskDbRow,
    execute: () =>
      sql`
        SELECT
          task_id AS "id",
          name,
          kind,
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          prompt,
          schedule_kind AS "scheduleKind",
          schedule_value AS "scheduleValue",
          timezone,
          status,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          overlap_policy AS "overlapPolicy",
          catch_up AS "catchUp",
          next_run_at AS "nextRunAt",
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_tasks
        WHERE status != 'deleted'
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const listDueTaskRows = SqlSchema.findAll({
    Request: ListDueScheduledTasksInput,
    Result: ScheduledTaskDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          task_id AS "id",
          name,
          kind,
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          prompt,
          schedule_kind AS "scheduleKind",
          schedule_value AS "scheduleValue",
          timezone,
          status,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          overlap_policy AS "overlapPolicy",
          catch_up AS "catchUp",
          next_run_at AS "nextRunAt",
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_tasks
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= ${now}
        ORDER BY next_run_at ASC, task_id ASC
        LIMIT 25
      `,
  });

  const softDeleteTaskRow = SqlSchema.void({
    Request: DeleteScheduledTaskInput,
    execute: ({ id, updatedAt }) =>
      sql`
        UPDATE scheduled_tasks
        SET status = 'deleted',
            next_run_at = NULL,
            updated_at = ${updatedAt}
        WHERE task_id = ${id}
      `,
  });

  const upsert: ScheduledTaskRepositoryShape["upsert"] = (task) =>
    upsertTaskRow(task).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRepository.upsert:query")),
    );

  const getById: ScheduledTaskRepositoryShape["getById"] = (input) =>
    getTaskRowById(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRepository.getById:query")),
      Effect.map(Option.map(toScheduledTask)),
    );

  const listAll: ScheduledTaskRepositoryShape["listAll"] = () =>
    listTaskRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRepository.listAll:query")),
      Effect.map((rows) => rows.map(toScheduledTask)),
    );

  const listDue: ScheduledTaskRepositoryShape["listDue"] = (input) =>
    listDueTaskRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRepository.listDue:query")),
      Effect.map((rows) => rows.map(toScheduledTask)),
    );

  const softDelete: ScheduledTaskRepositoryShape["softDelete"] = (input) =>
    softDeleteTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRepository.softDelete:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    listDue,
    softDelete,
  } satisfies ScheduledTaskRepositoryShape;
});

const makeScheduledTaskRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRunRow = SqlSchema.void({
    Request: ScheduledTaskRun,
    execute: (run) =>
      sql`
        INSERT INTO scheduled_task_runs (
          run_id,
          task_id,
          scheduled_for,
          status,
          thread_id,
          message_id,
          turn_id,
          started_at,
          finished_at,
          error,
          result_summary,
          created_at,
          updated_at
        )
        VALUES (
          ${run.id},
          ${run.taskId},
          ${run.scheduledFor},
          ${run.status},
          ${run.threadId},
          ${run.messageId},
          ${run.turnId},
          ${run.startedAt},
          ${run.finishedAt},
          ${run.error},
          ${run.resultSummary},
          ${run.createdAt},
          ${run.updatedAt}
        )
        ON CONFLICT (run_id)
        DO UPDATE SET
          task_id = excluded.task_id,
          scheduled_for = excluded.scheduled_for,
          status = excluded.status,
          thread_id = excluded.thread_id,
          message_id = excluded.message_id,
          turn_id = excluded.turn_id,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          error = excluded.error,
          result_summary = excluded.result_summary,
          updated_at = excluded.updated_at
      `,
  });

  const insertRunRow = SqlSchema.void({
    Request: ScheduledTaskRun,
    execute: (run) =>
      sql`
        INSERT INTO scheduled_task_runs (
          run_id,
          task_id,
          scheduled_for,
          status,
          thread_id,
          message_id,
          turn_id,
          started_at,
          finished_at,
          error,
          result_summary,
          created_at,
          updated_at
        )
        VALUES (
          ${run.id},
          ${run.taskId},
          ${run.scheduledFor},
          ${run.status},
          ${run.threadId},
          ${run.messageId},
          ${run.turnId},
          ${run.startedAt},
          ${run.finishedAt},
          ${run.error},
          ${run.resultSummary},
          ${run.createdAt},
          ${run.updatedAt}
        )
        ON CONFLICT (task_id, scheduled_for) DO NOTHING
      `,
  });

  const getRunRowById = SqlSchema.findOneOption({
    Request: GetScheduledTaskRunInput,
    Result: ScheduledTaskRun,
    execute: ({ id }) =>
      sql`
        SELECT
          run_id AS "id",
          task_id AS "taskId",
          scheduled_for AS "scheduledFor",
          status,
          thread_id AS "threadId",
          message_id AS "messageId",
          turn_id AS "turnId",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          error,
          result_summary AS "resultSummary",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_task_runs
        WHERE run_id = ${id}
      `,
  });

  const getRunRowByOccurrence = SqlSchema.findOneOption({
    Request: GetScheduledTaskRunByOccurrenceInput,
    Result: ScheduledTaskRun,
    execute: ({ taskId, scheduledFor }) =>
      sql`
        SELECT
          run_id AS "id",
          task_id AS "taskId",
          scheduled_for AS "scheduledFor",
          status,
          thread_id AS "threadId",
          message_id AS "messageId",
          turn_id AS "turnId",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          error,
          result_summary AS "resultSummary",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_task_runs
        WHERE task_id = ${taskId}
          AND scheduled_for = ${scheduledFor}
      `,
  });

  const listRunRowsByTaskId = SqlSchema.findAll({
    Request: ListScheduledTaskRunsInput,
    Result: ScheduledTaskRun,
    execute: ({ taskId }) =>
      sql`
        SELECT
          run_id AS "id",
          task_id AS "taskId",
          scheduled_for AS "scheduledFor",
          status,
          thread_id AS "threadId",
          message_id AS "messageId",
          turn_id AS "turnId",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          error,
          result_summary AS "resultSummary",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_task_runs
        WHERE task_id = ${taskId}
        ORDER BY scheduled_for DESC, run_id DESC
        LIMIT 100
      `,
  });

  const listOpenRunRows = SqlSchema.findAll({
    Request: ListOpenScheduledTaskRunsInput,
    Result: ScheduledTaskRun,
    execute: () =>
      sql`
        SELECT
          run_id AS "id",
          task_id AS "taskId",
          scheduled_for AS "scheduledFor",
          status,
          thread_id AS "threadId",
          message_id AS "messageId",
          turn_id AS "turnId",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          error,
          result_summary AS "resultSummary",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM scheduled_task_runs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at ASC, run_id ASC
        LIMIT 100
      `,
  });

  const upsert: ScheduledTaskRunRepositoryShape["upsert"] = (run) =>
    upsertRunRow(run).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRunRepository.upsert:query")),
    );

  const insert: ScheduledTaskRunRepositoryShape["insert"] = (run) =>
    insertRunRow(run).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRunRepository.insert:query")),
    );

  const getById: ScheduledTaskRunRepositoryShape["getById"] = (input) =>
    getRunRowById(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRunRepository.getById:query")),
    );

  const getByOccurrence: ScheduledTaskRunRepositoryShape["getByOccurrence"] = (input) =>
    getRunRowByOccurrence(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRunRepository.getByOccurrence:query")),
    );

  const listByTaskId: ScheduledTaskRunRepositoryShape["listByTaskId"] = (input) =>
    listRunRowsByTaskId(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRunRepository.listByTaskId:query")),
    );

  const listOpen: ScheduledTaskRunRepositoryShape["listOpen"] = (input) =>
    listOpenRunRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ScheduledTaskRunRepository.listOpen:query")),
    );

  return {
    upsert,
    insert,
    getById,
    getByOccurrence,
    listByTaskId,
    listOpen,
  } satisfies ScheduledTaskRunRepositoryShape;
});

export const ScheduledTaskRepositoryLive = Layer.effect(
  ScheduledTaskRepository,
  makeScheduledTaskRepository,
);

export const ScheduledTaskRunRepositoryLive = Layer.effect(
  ScheduledTaskRunRepository,
  makeScheduledTaskRunRepository,
);

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ScheduledTaskId,
  ScheduledTaskRRuleConfig,
  type ScheduledTask,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { computeNextRunAt, isOverdueByMoreThan } from "./Schedule.ts";

const encodeRRuleConfig = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskRRuleConfig));

const makeTask = (
  overrides: Pick<ScheduledTask, "scheduleKind" | "scheduleValue" | "timezone">,
): ScheduledTask => ({
  id: ScheduledTaskId.make("task-1"),
  name: "Morning check",
  kind: "standalone",
  projectId: ProjectId.make("project-1"),
  targetThreadId: null,
  prompt: "Check in.",
  status: "active",
  modelSelection: null,
  runtimeMode: null,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  overlapPolicy: "skip",
  catchUp: false,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("scheduled task schedule calculations", () => {
  it.effect("keeps a daily local time stable across DST", () =>
    Effect.gen(function* () {
      const task = makeTask({
        scheduleKind: "rrule",
        scheduleValue: encodeRRuleConfig({
          frequency: "daily",
          interval: 1,
          dtStart: "2026-01-01T17:00:00.000Z",
        }),
        timezone: "America/Los_Angeles",
      });

      assert.equal(
        yield* computeNextRunAt(task, "2026-01-01T00:00:00.000Z", { inclusive: true }),
        "2026-01-01T17:00:00.000Z",
      );
      assert.equal(
        yield* computeNextRunAt(task, "2026-07-01T00:00:00.000Z", { inclusive: true }),
        "2026-07-01T16:00:00.000Z",
      );
    }),
  );

  it.effect("does not return a one-time run after it has passed", () =>
    Effect.gen(function* () {
      const task = makeTask({
        scheduleKind: "once",
        scheduleValue: "2026-01-01T17:00:00.000Z",
        timezone: "America/Los_Angeles",
      });

      assert.equal(
        yield* computeNextRunAt(task, "2026-01-01T17:00:00.000Z", { inclusive: true }),
        "2026-01-01T17:00:00.000Z",
      );
      assert.equal(
        yield* computeNextRunAt(task, "2026-01-01T17:00:00.000Z", { inclusive: false }),
        null,
      );
    }),
  );

  it.effect("computes weekly recurrences with byDay filters", () =>
    Effect.gen(function* () {
      const task = makeTask({
        scheduleKind: "rrule",
        scheduleValue: encodeRRuleConfig({
          frequency: "weekly",
          interval: 1,
          dtStart: "2026-01-05T17:00:00.000Z",
          byDay: ["MO", "WE"],
        }),
        timezone: "America/Los_Angeles",
      });

      assert.equal(
        yield* computeNextRunAt(task, "2026-01-05T17:00:00.000Z", { inclusive: true }),
        "2026-01-05T17:00:00.000Z",
      );
      assert.equal(
        yield* computeNextRunAt(task, "2026-01-06T00:00:00.000Z", { inclusive: true }),
        "2026-01-07T17:00:00.000Z",
      );
    }),
  );

  it.effect("computes monthly recurrences with byMonthDay filters", () =>
    Effect.gen(function* () {
      const task = makeTask({
        scheduleKind: "rrule",
        scheduleValue: encodeRRuleConfig({
          frequency: "monthly",
          interval: 1,
          dtStart: "2026-01-10T17:00:00.000Z",
          byMonthDay: [15],
        }),
        timezone: "America/Los_Angeles",
      });

      assert.equal(
        yield* computeNextRunAt(task, "2026-01-10T17:00:00.000Z", { inclusive: true }),
        "2026-01-15T17:00:00.000Z",
      );
      assert.equal(
        yield* computeNextRunAt(task, "2026-01-16T00:00:00.000Z", { inclusive: true }),
        "2026-02-15T17:00:00.000Z",
      );
    }),
  );

  it.effect("detects runs outside the missed-run grace window", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* isOverdueByMoreThan(
          "2026-01-01T17:00:00.000Z",
          "2026-01-01T17:06:00.000Z",
          5 * 60 * 1_000,
        ),
        true,
      );
      assert.equal(
        yield* isOverdueByMoreThan(
          "2026-01-01T17:00:00.000Z",
          "2026-01-01T17:04:00.000Z",
          5 * 60 * 1_000,
        ),
        false,
      );
    }),
  );
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ScheduledTaskCreateInput,
  ScheduledTaskRRuleConfig,
  ScheduledTaskUpdateInput,
} from "./scheduledTasks.ts";

const decodeCreateInput = Schema.decodeUnknownSync(ScheduledTaskCreateInput);
const decodeUpdateInput = Schema.decodeUnknownSync(ScheduledTaskUpdateInput);
const encodeRRuleConfig = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskRRuleConfig));

const validRRule = encodeRRuleConfig({
  frequency: "daily",
  interval: 1,
  dtStart: "2026-01-01T17:00:00.000Z",
});

const baseCreateInput = {
  name: "Morning check",
  kind: "standalone",
  projectId: "project-1",
  prompt: "Summarize status.",
  scheduleKind: "once",
  scheduleValue: "2026-01-01T17:00:00.000Z",
  timezone: "America/Los_Angeles",
} as const;

describe("ScheduledTaskCreateInput", () => {
  it("accepts valid standalone and thread automations", () => {
    expect(decodeCreateInput(baseCreateInput).kind).toBe("standalone");
    expect(
      decodeCreateInput({
        ...baseCreateInput,
        kind: "thread",
        targetThreadId: "thread-1",
        scheduleKind: "rrule",
        scheduleValue: validRRule,
      }).targetThreadId,
    ).toBe("thread-1");
  });

  it("rejects invalid kind and target thread combinations", () => {
    expect(() =>
      decodeCreateInput({
        ...baseCreateInput,
        kind: "thread",
      }),
    ).toThrow();
    expect(() =>
      decodeCreateInput({
        ...baseCreateInput,
        targetThreadId: "thread-1",
      }),
    ).toThrow();
  });

  it("rejects schedule values that do not match their schedule kind", () => {
    expect(() =>
      decodeCreateInput({
        ...baseCreateInput,
        scheduleValue: "tomorrow-ish",
      }),
    ).toThrow();
    expect(() =>
      decodeCreateInput({
        ...baseCreateInput,
        scheduleKind: "rrule",
        scheduleValue: JSON.stringify({ frequency: "weekly" }),
      }),
    ).toThrow();
  });
});

describe("ScheduledTaskUpdateInput", () => {
  it("rejects patch combinations that are invalid on their face", () => {
    expect(() =>
      decodeUpdateInput({
        id: "task-1",
        patch: { kind: "thread" },
      }),
    ).toThrow();
    expect(() =>
      decodeUpdateInput({
        id: "task-1",
        patch: {
          kind: "standalone",
          targetThreadId: "thread-1",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeUpdateInput({
        id: "task-1",
        patch: {
          scheduleKind: "rrule",
          scheduleValue: "not-json",
        },
      }),
    ).toThrow();
  });
});

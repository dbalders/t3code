import {
  type ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskRRuleConfig,
  type ScheduledTaskRRuleFrequency,
  type ScheduledTaskWeekday,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import RRule, { Frequency, Weekday } from "rrule-es";

const decodeRRuleConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTaskRRuleConfig),
);
const isScheduledTaskError = Schema.is(ScheduledTaskError);

const FREQUENCY_BY_CONFIG: Record<ScheduledTaskRRuleFrequency, Frequency> = {
  daily: Frequency.DAILY,
  weekly: Frequency.WEEKLY,
  monthly: Frequency.MONTHLY,
};

const WEEKDAY_BY_CONFIG: Record<ScheduledTaskWeekday, Weekday> = {
  MO: Weekday.MO,
  TU: Weekday.TU,
  WE: Weekday.WE,
  TH: Weekday.TH,
  FR: Weekday.FR,
  SA: Weekday.SA,
  SU: Weekday.SU,
};

function toScheduledTaskError(message: string, cause?: unknown) {
  return new ScheduledTaskError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function parseDateTime(value: string, field: string) {
  return Effect.try({
    try: () => DateTime.makeUnsafe(value),
    catch: (cause) => toScheduledTaskError(`${field} must be a valid ISO date-time.`, cause),
  });
}

function parseIsoInstant(value: string, field: string) {
  return parseDateTime(value, field).pipe(Effect.map(DateTime.toDate));
}

function parseEpochMillis(value: string, field: string) {
  return parseDateTime(value, field).pipe(Effect.map(DateTime.toEpochMillis));
}

function parseRRuleConfig(value: string) {
  return decodeRRuleConfig(value).pipe(
    Effect.mapError((cause) =>
      toScheduledTaskError("RRULE schedule value is not a supported recurrence config.", cause),
    ),
  );
}

function makeRRule(
  task: Pick<ScheduledTask, "scheduleValue" | "timezone">,
): Effect.Effect<RRule, ScheduledTaskError> {
  return Effect.gen(function* () {
    const config = yield* parseRRuleConfig(task.scheduleValue);
    const params = {
      freq: FREQUENCY_BY_CONFIG[config.frequency],
      interval: config.interval,
      tzid: task.timezone,
      dtStart: yield* parseIsoInstant(config.dtStart, "dtStart"),
      ...(config.byDay !== undefined && config.byDay.length > 0
        ? { byDay: config.byDay.map((day) => WEEKDAY_BY_CONFIG[day]) }
        : {}),
      ...(config.byMonthDay !== undefined && config.byMonthDay.length > 0
        ? { byMonthDay: config.byMonthDay }
        : {}),
      ...(config.count !== undefined ? { count: config.count } : {}),
      ...(config.until !== undefined
        ? { until: yield* parseIsoInstant(config.until, "until") }
        : {}),
    };
    const validationErrors = RRule.validate(params);
    if (validationErrors.length > 0) {
      return yield* toScheduledTaskError(validationErrors.join("; "));
    }
    return RRule.strict(params);
  }).pipe(
    Effect.mapError((cause) =>
      isScheduledTaskError(cause)
        ? cause
        : toScheduledTaskError("Failed to build RRULE schedule.", cause),
    ),
  );
}

export function computeNextRunAt(
  task: Pick<ScheduledTask, "scheduleKind" | "scheduleValue" | "timezone">,
  afterIso: string,
  options: { readonly inclusive: boolean },
): Effect.Effect<string | null, ScheduledTaskError> {
  return Effect.gen(function* () {
    const after = yield* parseIsoInstant(afterIso, "after");
    if (task.scheduleKind === "once") {
      const runAt = yield* parseIsoInstant(task.scheduleValue, "scheduleValue");
      const isNext = options.inclusive ? runAt.getTime() >= after.getTime() : runAt > after;
      return isNext ? runAt.toISOString() : null;
    }

    const rule = yield* makeRRule(task);
    return rule.after(after, { inclusive: options.inclusive })?.toISOString() ?? null;
  }).pipe(
    Effect.mapError((cause) =>
      isScheduledTaskError(cause)
        ? cause
        : toScheduledTaskError("Failed to calculate the next scheduled run.", cause),
    ),
  );
}

export function isOverdueByMoreThan(
  scheduledForIso: string,
  nowIso: string,
  milliseconds: number,
): Effect.Effect<boolean, ScheduledTaskError> {
  return Effect.gen(function* () {
    const [nowMs, scheduledForMs] = yield* Effect.all([
      parseEpochMillis(nowIso, "now"),
      parseEpochMillis(scheduledForIso, "scheduledFor"),
    ]);
    return nowMs - scheduledForMs > milliseconds;
  });
}

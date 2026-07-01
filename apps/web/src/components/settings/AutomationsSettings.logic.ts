interface DateTimeLocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseDatetimeLocalParts(value: string): DateTimeLocalParts | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  } satisfies DateTimeLocalParts;
  const roundTrip = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  if (
    roundTrip.getUTCFullYear() !== parts.year ||
    roundTrip.getUTCMonth() !== parts.month - 1 ||
    roundTrip.getUTCDate() !== parts.day ||
    roundTrip.getUTCHours() !== parts.hour ||
    roundTrip.getUTCMinutes() !== parts.minute
  ) {
    return null;
  }
  return parts;
}

function toDatetimeLocalInputValue(parts: DateTimeLocalParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(
    parts.minute,
  )}`;
}

function getZonedDateTimeParts(date: Date, timezone: string): DateTimeLocalParts | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const values = new Map(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const hour = Number(values.get("hour"));
    const parts = {
      year: Number(values.get("year")),
      month: Number(values.get("month")),
      day: Number(values.get("day")),
      hour: hour === 24 ? 0 : hour,
      minute: Number(values.get("minute")),
    } satisfies DateTimeLocalParts;
    return Object.values(parts).every(Number.isFinite) ? parts : null;
  } catch {
    return null;
  }
}

function asUtcMilliseconds(parts: DateTimeLocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function isSameDateTimeLocalParts(left: DateTimeLocalParts, right: DateTimeLocalParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

export function datetimeLocalToIsoInTimeZone(value: string, timezone: string): string | null {
  const target = parseDatetimeLocalParts(value);
  const trimmedTimezone = timezone.trim();
  if (!target || !trimmedTimezone) return null;

  const targetAsUtc = asUtcMilliseconds(target);
  let utcMs = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedDateTimeParts(new Date(utcMs), trimmedTimezone);
    if (!actual) return null;
    const delta = targetAsUtc - asUtcMilliseconds(actual);
    if (delta === 0) break;
    utcMs += delta;
  }

  const resolved = getZonedDateTimeParts(new Date(utcMs), trimmedTimezone);
  if (!resolved || !isSameDateTimeLocalParts(resolved, target)) return null;
  return new Date(utcMs).toISOString();
}

export function datetimeLocalFromIsoInTimeZone(iso: string, timezone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = getZonedDateTimeParts(date, timezone.trim());
  return parts ? toDatetimeLocalInputValue(parts) : null;
}

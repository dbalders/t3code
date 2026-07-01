import { describe, expect, it } from "vite-plus/test";
import {
  datetimeLocalFromIsoInTimeZone,
  datetimeLocalToIsoInTimeZone,
} from "./AutomationsSettings.logic";

describe("automation datetime timezone conversion", () => {
  it("encodes datetime-local wall time in the selected timezone", () => {
    expect(datetimeLocalToIsoInTimeZone("2026-01-15T09:00", "America/New_York")).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    expect(datetimeLocalToIsoInTimeZone("2026-01-15T09:00", "America/Los_Angeles")).toBe(
      "2026-01-15T17:00:00.000Z",
    );
  });

  it("formats stored instants back into datetime-local values for the task timezone", () => {
    expect(datetimeLocalFromIsoInTimeZone("2026-01-15T14:00:00.000Z", "America/New_York")).toBe(
      "2026-01-15T09:00",
    );
    expect(
      datetimeLocalFromIsoInTimeZone("2026-01-15T14:00:00.000Z", "America/Los_Angeles"),
    ).toBe("2026-01-15T06:00");
  });
});

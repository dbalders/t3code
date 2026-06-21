import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("BUILT_IN_DRIVERS", () => {
  it("hydrates OpenCode before other built-in providers", () => {
    expect(BUILT_IN_DRIVERS[0]?.driverKind).toBe("opencode");
  });
});

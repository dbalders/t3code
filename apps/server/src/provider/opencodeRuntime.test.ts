import { describe, expect, it } from "vitest";

import { buildOpenCodeServerEnvironment } from "./opencodeRuntime.ts";

describe("buildOpenCodeServerEnvironment", () => {
  it("does not inject inline OpenCode config when OPENCODE_CONFIG points at a file", () => {
    const env = buildOpenCodeServerEnvironment({
      PATH: "/managed/bin",
      OPENCODE_CONFIG: "/Users/test/.config/opencode/opencode.json",
      OPENCODE_CONFIG_CONTENT: "{}",
      TRITONAI_API_KEY: "test-key",
    });

    expect(env.OPENCODE_CONFIG).toBe("/Users/test/.config/opencode/opencode.json");
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.PATH).toBe("/managed/bin");
    expect(env.TRITONAI_API_KEY).toBe("test-key");
  });

  it("uses an empty inline config only when no config file is provided", () => {
    const env = buildOpenCodeServerEnvironment({ PATH: "/managed/bin" });

    expect(env.OPENCODE_CONFIG_CONTENT).toBe("{}");
  });
});

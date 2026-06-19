import { describe, expect, it } from "vitest";

import {
  buildOpenCodeServerEnvironment,
  isOpenCodeDatabaseLockedError,
  OpenCodeRuntimeError,
  openCodeLocalServerLockKey,
} from "./opencodeRuntime.ts";

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

describe("OpenCode local server locking", () => {
  it("recognizes OpenCode database lock startup failures", () => {
    const error = new OpenCodeRuntimeError({
      operation: "startOpenCodeServerProcess",
      detail:
        "OpenCode server exited before startup completed (code: 1).\n\nstderr:\ndatabase is locked",
    });

    expect(isOpenCodeDatabaseLockedError(error)).toBe(true);
  });

  it("keys local server leases by OpenCode data scope", () => {
    const first = openCodeLocalServerLockKey({
      binaryPath: "/managed/opencode-a",
      environment: {
        OPENCODE_CONFIG: "/Users/test/.agents/ucsd/config/opencode/opencode.json",
        XDG_DATA_HOME: "/Users/test/.agents/ucsd/data",
      },
    });
    const second = openCodeLocalServerLockKey({
      binaryPath: "/managed/opencode-b",
      environment: {
        OPENCODE_CONFIG: "/Users/test/.agents/ucsd/config/opencode/opencode.json",
        XDG_DATA_HOME: "/Users/test/.agents/ucsd/data",
      },
    });
    const isolated = openCodeLocalServerLockKey({
      binaryPath: "/managed/opencode-a",
      environment: {
        OPENCODE_CONFIG: "/Users/test/.config/opencode/opencode.json",
        XDG_DATA_HOME: "/Users/test/.local/share",
      },
    });

    expect(first).toBe(second);
    expect(first).not.toBe(isolated);
  });

  it("does not split default data-directory locks by config path", () => {
    const first = openCodeLocalServerLockKey({
      binaryPath: "/managed/opencode-a",
      environment: {
        HOME: "/Users/test",
        OPENCODE_CONFIG: "/Users/test/.config/opencode/opencode.json",
      },
    });
    const second = openCodeLocalServerLockKey({
      binaryPath: "/managed/opencode-b",
      environment: {
        HOME: "/Users/test",
        OPENCODE_CONFIG: "/Users/test/.agents/ucsd/config/opencode/opencode.json",
      },
    });

    expect(first).toBe(second);
  });
});

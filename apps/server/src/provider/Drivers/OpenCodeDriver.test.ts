import { describe, expect, it } from "@effect/vitest";

import {
  isDefaultOpenCodeBinaryPath,
  isInstallerManagedOpenCodeBinaryPath,
  mergeInstallerManagedOpenCodeEnvironment,
  resolveInstallerManagedOpenCodeBinaryPath,
  selectInstallerManagedOpenCodeVersionDirectory,
} from "./OpenCodeDriver.js";

describe("OpenCodeDriver", () => {
  it("recognizes installer-managed OpenCode binary paths", () => {
    expect(
      isInstallerManagedOpenCodeBinaryPath(
        "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.15.13/bin/opencode",
      ),
    ).toBe(true);
    expect(
      isInstallerManagedOpenCodeBinaryPath(
        "C:\\Users\\test\\.agents\\ucsd\\runtime\\opencode\\opencode-ai-1.15.13\\opencode.cmd",
      ),
    ).toBe(true);
    expect(isInstallerManagedOpenCodeBinaryPath("/opt/homebrew/bin/opencode")).toBe(false);
    expect(isInstallerManagedOpenCodeBinaryPath("opencode")).toBe(false);
  });

  it("only treats the stock OpenCode command as the overridable default", () => {
    expect(isDefaultOpenCodeBinaryPath("opencode")).toBe(true);
    expect(isDefaultOpenCodeBinaryPath("opencode.exe")).toBe(true);
    expect(isDefaultOpenCodeBinaryPath("/opt/homebrew/bin/opencode")).toBe(false);
    expect(
      isDefaultOpenCodeBinaryPath(
        "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin/opencode",
      ),
    ).toBe(false);
  });

  it("selects the newest installer-managed OpenCode runtime directory", () => {
    expect(
      selectInstallerManagedOpenCodeVersionDirectory([
        "opencode-ai-1.17.8",
        "README.md",
        "opencode-ai-1.18.0-beta.1",
        "opencode-ai-1.18.0",
        "opencode-ai-1.16.9",
      ]),
    ).toBe("opencode-ai-1.18.0");
    expect(selectInstallerManagedOpenCodeVersionDirectory(["README.md"])).toBe(null);
  });

  it("advances default and installer-managed binary paths to the discovered runtime", () => {
    const currentBinary =
      "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.18.0/bin/opencode";
    expect(
      resolveInstallerManagedOpenCodeBinaryPath({
        configuredBinaryPath: "opencode",
        installerRuntimeBinaryPath: currentBinary,
      }),
    ).toBe(currentBinary);
    expect(
      resolveInstallerManagedOpenCodeBinaryPath({
        configuredBinaryPath:
          "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin/opencode",
        installerRuntimeBinaryPath: currentBinary,
      }),
    ).toBe(currentBinary);
    expect(
      resolveInstallerManagedOpenCodeBinaryPath({
        configuredBinaryPath: "/opt/homebrew/bin/opencode",
        installerRuntimeBinaryPath: currentBinary,
      }),
    ).toBe("/opt/homebrew/bin/opencode");
  });

  it("prepends the installer binary directory and preserves explicit OpenCode config", () => {
    const merged = mergeInstallerManagedOpenCodeEnvironment(
      {
        PATH: "/usr/bin",
        OPENCODE_CONFIG: "/custom/opencode.json",
      },
      {
        binaryPath: "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin/opencode",
        binDir: "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin",
        configPath: "/Users/test/.agents/ucsd/config/opencode/opencode.json",
        configHome: "/Users/test/.agents/ucsd/config",
        cacheHome: "/Users/test/.agents/ucsd/cache",
        dataHome: "/Users/test/.agents/ucsd/data",
        stateHome: "/Users/test/.agents/ucsd/state",
      },
      "darwin",
    );

    expect(merged.PATH?.split(":")[0]).toBe(
      "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin",
    );
    expect(merged.OPENCODE_CONFIG).toBe("/custom/opencode.json");
  });

  it("uses the installer OpenCode config when no explicit config is present", () => {
    const merged = mergeInstallerManagedOpenCodeEnvironment(
      { PATH: "/usr/bin" },
      {
        binaryPath: "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin/opencode",
        binDir: "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin",
        configPath: "/Users/test/.agents/ucsd/config/opencode/opencode.json",
        configHome: "/Users/test/.agents/ucsd/config",
        cacheHome: "/Users/test/.agents/ucsd/cache",
        dataHome: "/Users/test/.agents/ucsd/data",
        stateHome: "/Users/test/.agents/ucsd/state",
      },
      "darwin",
    );

    expect(merged.OPENCODE_CONFIG).toBe("/Users/test/.agents/ucsd/config/opencode/opencode.json");
    expect(merged.XDG_CONFIG_HOME).toBe("/Users/test/.agents/ucsd/config");
    expect(merged.XDG_CACHE_HOME).toBe("/Users/test/.agents/ucsd/cache");
    expect(merged.XDG_DATA_HOME).toBe("/Users/test/.agents/ucsd/data");
    expect(merged.XDG_STATE_HOME).toBe("/Users/test/.agents/ucsd/state");
  });

  it("preserves explicit installer-related XDG environment values", () => {
    const merged = mergeInstallerManagedOpenCodeEnvironment(
      {
        PATH: "/usr/bin",
        XDG_DATA_HOME: "/custom/data",
        XDG_STATE_HOME: "/custom/state",
      },
      {
        binaryPath: "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin/opencode",
        binDir: "/Users/test/.agents/ucsd/runtime/opencode/opencode-ai-1.17.8/bin",
        configPath: "/Users/test/.agents/ucsd/config/opencode/opencode.json",
        configHome: "/Users/test/.agents/ucsd/config",
        cacheHome: "/Users/test/.agents/ucsd/cache",
        dataHome: "/Users/test/.agents/ucsd/data",
        stateHome: "/Users/test/.agents/ucsd/state",
      },
      "darwin",
    );

    expect(merged.XDG_DATA_HOME).toBe("/custom/data");
    expect(merged.XDG_STATE_HOME).toBe("/custom/state");
    expect(merged.XDG_CONFIG_HOME).toBe("/Users/test/.agents/ucsd/config");
  });
});

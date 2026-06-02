import { describe, expect, it } from "vitest";

import { isInstallerManagedOpenCodeBinaryPath } from "./OpenCodeDriver.js";

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
});

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_VOICE_INPUT_SETTINGS } from "./voice.ts";

describe("DEFAULT_VOICE_INPUT_SETTINGS", () => {
  it("keeps server-backed voice dictation disabled until explicitly enabled", () => {
    expect(DEFAULT_VOICE_INPUT_SETTINGS.enabled).toBe(false);
  });
});

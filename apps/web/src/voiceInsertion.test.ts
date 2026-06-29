import { describe, expect, it } from "vite-plus/test";

import { insertVoiceTranscript } from "./voiceInsertion";

describe("insertVoiceTranscript", () => {
  it("appends with whitespace between existing text and transcript", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Summarize this",
        },
        transcript: "and include risks",
      }),
    ).toEqual({
      text: "Summarize this and include risks",
      cursor: "Summarize this and include risks".length,
    });
  });

  it("always appends, even when the cursor is earlier in the draft", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Ask  about tests",
        },
        transcript: "Claude",
      }),
    ).toEqual({
      text: "Ask  about tests Claude",
      cursor: "Ask  about tests Claude".length,
    });
  });

  it("always appends, even when text is selected", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Refactor the old helper today",
        },
        transcript: "new",
      }),
    ).toEqual({
      text: "Refactor the old helper today new",
      cursor: "Refactor the old helper today new".length,
    });
  });
});

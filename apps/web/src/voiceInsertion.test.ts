import { describe, expect, it } from "vite-plus/test";

import { insertVoiceTranscript } from "./voiceInsertion";

describe("insertVoiceTranscript", () => {
  it("appends with whitespace between existing text and transcript", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Summarize this",
          expandedCursor: "Summarize this".length,
          expandedSelectionStart: "Summarize this".length,
          expandedSelectionEnd: "Summarize this".length,
        },
        transcript: "and include risks",
        mode: "append",
      }),
    ).toEqual({
      text: "Summarize this and include risks",
      cursor: "Summarize this and include risks".length,
    });
  });

  it("inserts at the active cursor", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Ask  about tests",
          expandedCursor: "Ask ".length,
          expandedSelectionStart: "Ask ".length,
          expandedSelectionEnd: "Ask ".length,
        },
        transcript: "Claude",
        mode: "insert-at-cursor",
      }),
    ).toEqual({
      text: "Ask Claude about tests",
      cursor: "Ask Claude".length,
    });
  });

  it("replaces the active selection", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Refactor the old helper today",
          expandedCursor: "Refactor the old".length,
          expandedSelectionStart: "Refactor the ".length,
          expandedSelectionEnd: "Refactor the old".length,
        },
        transcript: "new",
        mode: "replace-selection",
      }),
    ).toEqual({
      text: "Refactor the new helper today",
      cursor: "Refactor the new".length,
    });
  });

  it("falls back to the cursor when replace-selection has no selected text", () => {
    expect(
      insertVoiceTranscript({
        snapshot: {
          value: "Ship today",
          expandedCursor: "Ship".length,
          expandedSelectionStart: "Ship".length,
          expandedSelectionEnd: "Ship".length,
        },
        transcript: " this",
        mode: "replace-selection",
      }),
    ).toEqual({
      text: "Ship this today",
      cursor: "Ship this".length,
    });
  });
});

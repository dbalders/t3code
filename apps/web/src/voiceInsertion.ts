import type { VoiceComposerMode } from "@t3tools/contracts";

import { replaceTextRange } from "./composer-logic";

export interface VoiceInsertionSnapshot {
  readonly value: string;
  readonly expandedCursor: number;
  readonly expandedSelectionStart: number;
  readonly expandedSelectionEnd: number;
}

export interface VoiceInsertionResult {
  readonly text: string;
  readonly cursor: number;
}

function needsLeadingSpace(before: string, text: string): boolean {
  return before.length > 0 && text.length > 0 && !/\s$/u.test(before) && !/^\s/u.test(text);
}

function needsTrailingSpace(after: string, text: string): boolean {
  return after.length > 0 && text.length > 0 && !/^\s/u.test(after) && !/\s$/u.test(text);
}

function normalizeTranscriptForRange(input: {
  readonly value: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly transcript: string;
}): string {
  let text = input.transcript.trim();
  const before = input.value.slice(0, input.rangeStart);
  const after = input.value.slice(input.rangeEnd);

  if (needsLeadingSpace(before, text)) {
    text = ` ${text}`;
  }
  if (needsTrailingSpace(after, text)) {
    text = `${text} `;
  }
  return text;
}

export function insertVoiceTranscript(input: {
  readonly snapshot: VoiceInsertionSnapshot;
  readonly transcript: string;
  readonly mode: VoiceComposerMode;
}): VoiceInsertionResult {
  const value = input.snapshot.value;
  const selectionStart = Math.max(0, Math.min(value.length, input.snapshot.expandedSelectionStart));
  const selectionEnd = Math.max(
    selectionStart,
    Math.min(value.length, input.snapshot.expandedSelectionEnd),
  );
  const cursor = Math.max(0, Math.min(value.length, input.snapshot.expandedCursor));
  const hasSelection = selectionEnd > selectionStart;

  const [rangeStart, rangeEnd] =
    input.mode === "append"
      ? [value.length, value.length]
      : input.mode === "replace-selection" && hasSelection
        ? [selectionStart, selectionEnd]
        : [cursor, cursor];

  const replacement = normalizeTranscriptForRange({
    value,
    rangeStart,
    rangeEnd,
    transcript: input.transcript,
  });

  return replaceTextRange(value, rangeStart, rangeEnd, replacement);
}

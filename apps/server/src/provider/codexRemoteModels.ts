import { T3_CODEX_OPENAI_BASE_URL } from "@t3tools/shared/codex";

export class CodexRemoteModelsError extends Error {
  readonly status: number | null;

  constructor(message: string, status?: number | null) {
    super(message);
    this.name = "CodexRemoteModelsError";
    this.status = status ?? null;
  }
}

function readErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }

  const nestedError = record.error;
  if (nestedError && typeof nestedError === "object") {
    const errorRecord = nestedError as Record<string, unknown>;
    if (typeof errorRecord.message === "string" && errorRecord.message.trim().length > 0) {
      return errorRecord.message.trim();
    }
  }

  return undefined;
}

function readModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const entries = (payload as { data?: unknown }).data;
  if (!globalThis.Array.isArray(entries)) {
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }

  return ids;
}

export async function fetchCodexRemoteModelIds(input: {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<string>> {
  const response = await fetch(new URL("models", T3_CODEX_OPENAI_BASE_URL), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const payloadText = await response.text();
  let payload: unknown = undefined;
  if (payloadText.trim().length > 0) {
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const detail = readErrorMessage(payload);
    throw new CodexRemoteModelsError(
      detail
        ? `UCSD model discovery failed: ${detail}`
        : `UCSD model discovery failed with ${response.status} ${response.statusText}.`,
      response.status,
    );
  }

  const modelIds = readModelIds(payload);
  if (modelIds.length === 0) {
    throw new CodexRemoteModelsError("UCSD model discovery returned no models.");
  }

  return modelIds;
}

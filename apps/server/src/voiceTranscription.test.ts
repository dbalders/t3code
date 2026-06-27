import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { transcribeVoice } from "./voiceTranscription.ts";

const audioBase64 = Buffer.from("voice bytes").toString("base64");

function makeInput(overrides: Partial<Parameters<typeof transcribeVoice>[0]> = {}) {
  return {
    audioBase64,
    mimeType: "audio/webm",
    ...overrides,
  };
}

describe("transcribeVoice", () => {
  it.effect("posts a multipart transcription request and returns provider text", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          expect(_url).toBe("https://tritonai-api.ucsd.edu/v1/audio/transcriptions");
          expect(init?.method).toBe("POST");
          expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
          expect(init?.body).toBeInstanceOf(FormData);
          const form = init?.body as FormData;
          expect(form.get("model")).toBe("api-cohere-transcribe");
          expect(form.get("language")).toBe("en");
          expect(form.get("response_format")).toBe("json");
          expect(form.get("file")).toBeInstanceOf(Blob);
          return new Response(
            JSON.stringify({ text: "transcribed prompt", usage: { seconds: 5 } }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        },
      );

      const result = yield* transcribeVoice(makeInput(), {
        env: { TRITONAI_API_KEY: "test-key" },
        fetch: fetchMock as unknown as typeof fetch,
      });

      assert.deepStrictEqual(result, { text: "transcribed prompt", usage: { seconds: 5 } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses caller-provided endpoint only when it matches server config", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          expect(_url).toBe("https://voice.example.test/v1/audio/transcriptions");
          const form = init?.body as FormData;
          expect(form.get("model")).toBe("custom-transcribe");
          expect(form.get("language")).toBe("es");
          return new Response(JSON.stringify({ text: "hola" }), {
            headers: { "content-type": "application/json" },
          });
        },
      );

      const result = yield* transcribeVoice(
        makeInput({
          baseUrl: "https://voice.example.test/v1/",
          model: "custom-transcribe",
          language: "es",
        }),
        {
          env: {
            TRITONAI_API_KEY: "test-key",
            UCSD_AI_BASE_URL: "https://voice.example.test/v1/",
          },
          fetch: fetchMock as unknown as typeof fetch,
        },
      );

      assert.deepStrictEqual(result, { text: "hola" });
    }),
  );

  it.effect("rejects untrusted caller-provided endpoints before fetch", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        transcribeVoice(makeInput({ baseUrl: "https://attacker.example.test/v1" }), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "invalid_base_url");
      assert.match(error.message, /not allowed/u);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails before fetch when the server API key is missing", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        transcribeVoice(makeInput(), {
          env: {},
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "missing_api_key");
      assert.equal(error.recoverable, true);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps provider errors to recoverable transcription errors", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      });

      const error = yield* Effect.flip(
        transcribeVoice(makeInput(), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "provider_error");
      assert.match(error.message, /rate limited/u);
      assert.equal(error.recoverable, true);
      assert.equal(error.status, 429);
    }),
  );
});

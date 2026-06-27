import { describe, expect, it, vi } from "vite-plus/test";
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
  it("posts a multipart transcription request and returns provider text", async () => {
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
        return new Response(JSON.stringify({ text: "transcribed prompt", usage: { seconds: 5 } }), {
          headers: { "content-type": "application/json" },
        });
      },
    );

    await expect(
      Effect.runPromise(
        transcribeVoice(makeInput(), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      ),
    ).resolves.toEqual({ text: "transcribed prompt", usage: { seconds: 5 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses caller-provided endpoint, model, and language", async () => {
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

    await expect(
      Effect.runPromise(
        transcribeVoice(
          makeInput({
            baseUrl: "https://voice.example.test/v1/",
            model: "custom-transcribe",
            language: "es",
          }),
          {
            env: { TRITONAI_API_KEY: "test-key" },
            fetch: fetchMock as unknown as typeof fetch,
          },
        ),
      ),
    ).resolves.toEqual({ text: "hola" });
  });

  it("fails before fetch when the server API key is missing", async () => {
    const fetchMock = vi.fn();

    await expect(
      Effect.runPromise(
        transcribeVoice(makeInput(), {
          env: {},
          fetch: fetchMock as unknown as typeof fetch,
        }),
      ),
    ).rejects.toMatchObject({
      code: "missing_api_key",
      recoverable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps provider errors to recoverable transcription errors", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      Effect.runPromise(
        transcribeVoice(makeInput(), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      ),
    ).rejects.toMatchObject({
      code: "provider_error",
      message: expect.stringContaining("rate limited"),
      recoverable: true,
      status: 429,
    });
  });
});

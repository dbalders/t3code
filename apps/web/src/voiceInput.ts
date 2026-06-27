import type { VoiceInputSettings } from "@t3tools/contracts";

import { ensureLocalApi } from "./localApi";

const VOICE_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/wav",
] as const;

export interface VoiceRecorderSession {
  readonly mimeType: string;
  readonly stop: () => Promise<Blob>;
  readonly cancel: () => void;
}

function resolveVoiceRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  return VOICE_RECORDING_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function createVoiceRecorder(): Promise<VoiceRecorderSession> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Microphone recording is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = resolveVoiceRecordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  let stopped = false;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const stop = () =>
    new Promise<Blob>((resolve, reject) => {
      if (stopped) {
        reject(new Error("Voice recording has already stopped."));
        return;
      }
      stopped = true;
      recorder.addEventListener(
        "stop",
        () => {
          stopMediaStream(stream);
          resolve(
            new Blob(chunks.splice(0), { type: recorder.mimeType || mimeType || "audio/webm" }),
          );
        },
        { once: true },
      );
      recorder.addEventListener(
        "error",
        () => {
          stopMediaStream(stream);
          reject(new Error("Voice recording failed."));
        },
        { once: true },
      );
      recorder.stop();
    });

  const cancel = () => {
    if (!stopped) {
      stopped = true;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }
    chunks.splice(0);
    stopMediaStream(stream);
  };

  recorder.start();

  return {
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    stop,
    cancel,
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function transcribeVoiceBlob(
  blob: Blob,
  settings: VoiceInputSettings,
): Promise<string> {
  const audioBase64 = await blobToBase64(blob);
  const result = await ensureLocalApi().server.transcribeVoice({
    audioBase64,
    mimeType: blob.type || "audio/webm",
    baseUrl: settings.baseUrl,
    model: settings.model,
    language: settings.language,
  });
  return result.text;
}

export function formatVoiceInputError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return "Voice dictation failed. Try again.";
}

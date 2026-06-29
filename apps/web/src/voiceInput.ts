import { DEFAULT_VOICE_TRANSCRIPTION_BASE_URL, type VoiceInputSettings } from "@t3tools/contracts";

import { ensureLocalApi } from "./localApi";

const VOICE_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/wav",
] as const;

const VOICE_TRANSCRIPTION_READY_MIME_TYPES = new Set([
  "audio/flac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
]);

type AudioContextConstructor = typeof AudioContext;

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
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stopMediaStream(stream);
    throw error;
  }
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
      try {
        recorder.stop();
      } catch (error) {
        chunks.splice(0);
        stopMediaStream(stream);
        reject(error);
      }
    });

  const cancel = () => {
    if (!stopped) {
      stopped = true;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // The stream is stopped below even if MediaRecorder cannot transition cleanly.
        }
      }
    }
    chunks.splice(0);
    stopMediaStream(stream);
  };

  try {
    recorder.start();
  } catch (error) {
    chunks.splice(0);
    stopMediaStream(stream);
    throw error;
  }

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

function normalizedMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
}

function isTranscriptionReadyMimeType(mimeType: string): boolean {
  return VOICE_TRANSCRIPTION_READY_MIME_TYPES.has(normalizedMimeType(mimeType));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodeAudioBufferAsWav(
  audioBuffer: Pick<AudioBuffer, "getChannelData" | "length" | "numberOfChannels" | "sampleRate">,
): ArrayBuffer {
  const channelCount = Math.max(1, Math.min(audioBuffer.numberOfChannels, 2));
  const sampleCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = sampleCount * blockAlign;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  let offset = 44;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channelIndex]?.[sampleIndex] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return output;
}

async function convertVoiceBlobToWav(blob: Blob): Promise<Blob> {
  const AudioContextCtor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Voice recording format is not supported by this browser.");
  }

  const audioContext = new AudioContextCtor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return new Blob([encodeAudioBufferAsWav(audioBuffer)], { type: "audio/wav" });
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}

async function prepareVoiceBlobForTranscription(blob: Blob): Promise<Blob> {
  if (isTranscriptionReadyMimeType(blob.type)) {
    return blob;
  }
  return convertVoiceBlobToWav(blob);
}

function normalizeVoiceBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function requestBaseUrl(settings: VoiceInputSettings): string | undefined {
  const baseUrl = normalizeVoiceBaseUrl(settings.baseUrl);
  if (!baseUrl || baseUrl === normalizeVoiceBaseUrl(DEFAULT_VOICE_TRANSCRIPTION_BASE_URL)) {
    return undefined;
  }
  return baseUrl;
}

export async function transcribeVoiceBlob(
  blob: Blob,
  settings: VoiceInputSettings,
): Promise<string> {
  const uploadBlob = await prepareVoiceBlobForTranscription(blob);
  const audioBase64 = await blobToBase64(uploadBlob);
  const baseUrl = requestBaseUrl(settings);
  const result = await ensureLocalApi().server.transcribeVoice({
    audioBase64,
    mimeType: uploadBlob.type || "audio/wav",
    ...(baseUrl ? { baseUrl } : {}),
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

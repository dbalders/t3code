import { describe, expect, it } from "vite-plus/test";

import {
  analyzeAudioBufferSignal,
  encodeAudioBufferAsWav,
  hasSpeechLikeSignal,
} from "./voiceInput";

function ascii(arrayBuffer: ArrayBuffer, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));
}

function fakeAudioBuffer(input: {
  readonly channels: readonly Float32Array<ArrayBuffer>[];
  readonly sampleRate: number;
}): Pick<AudioBuffer, "getChannelData" | "length" | "numberOfChannels" | "sampleRate"> {
  return {
    length: input.channels[0]?.length ?? 0,
    numberOfChannels: input.channels.length,
    sampleRate: input.sampleRate,
    getChannelData: (index: number) => input.channels[index] ?? new Float32Array(),
  };
}

describe("encodeAudioBufferAsWav", () => {
  it("writes a PCM WAV header and interleaves stereo samples", () => {
    const left = new Float32Array([0, 1, -1]);
    const right = new Float32Array([0.5, -0.5, 0]);
    const wav = encodeAudioBufferAsWav(
      fakeAudioBuffer({
        channels: [left, right],
        sampleRate: 44_100,
      }),
    );
    const view = new DataView(wav);

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16_383);
    expect(view.getInt16(48, true)).toBe(32_767);
    expect(view.getInt16(50, true)).toBe(-16_384);
    expect(view.getInt16(52, true)).toBe(-32_768);
    expect(view.getInt16(54, true)).toBe(0);
  });
});

describe("voice audio signal detection", () => {
  it("rejects silent recordings", () => {
    const signal = analyzeAudioBufferSignal(
      fakeAudioBuffer({
        channels: [new Float32Array(16_000)],
        sampleRate: 16_000,
      }),
    );

    expect(signal.peakAmplitude).toBe(0);
    expect(signal.rmsAmplitude).toBe(0);
    expect(signal.activeDurationSeconds).toBe(0);
    expect(hasSpeechLikeSignal(signal)).toBe(false);
  });

  it("accepts speech-like recordings", () => {
    const samples = new Float32Array(16_000);
    for (let index = 2_000; index < 6_000; index += 1) {
      samples[index] = Math.sin(index / 8) * 0.08;
    }

    const signal = analyzeAudioBufferSignal(
      fakeAudioBuffer({
        channels: [samples],
        sampleRate: 16_000,
      }),
    );

    expect(signal.peakAmplitude).toBeGreaterThan(0.015);
    expect(signal.rmsAmplitude).toBeGreaterThan(0.002);
    expect(signal.activeDurationSeconds).toBeGreaterThan(0.08);
    expect(hasSpeechLikeSignal(signal)).toBe(true);
  });
});

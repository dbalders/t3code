import { describe, expect, it } from "vite-plus/test";

import { encodeAudioBufferAsWav } from "./voiceInput";

function ascii(arrayBuffer: ArrayBuffer, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));
}

describe("encodeAudioBufferAsWav", () => {
  it("writes a PCM WAV header and interleaves stereo samples", () => {
    const left = new Float32Array([0, 1, -1]);
    const right = new Float32Array([0.5, -0.5, 0]);
    const wav = encodeAudioBufferAsWav({
      length: 3,
      numberOfChannels: 2,
      sampleRate: 44_100,
      getChannelData: (index) => (index === 0 ? left : right),
    });
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

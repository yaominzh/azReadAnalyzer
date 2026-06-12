import { describe, it, expect } from "vitest";
import { int16ChunkToFloat32 } from "./streamPlayer";

// helper: build a Uint8Array of int16 LE samples
function pcm(...vals: number[]): Uint8Array {
  const u = new Uint8Array(vals.length * 2);
  const dv = new DataView(u.buffer);
  vals.forEach((v, i) => dv.setInt16(i * 2, v, true));
  return u;
}

describe("int16ChunkToFloat32", () => {
  it("converts whole frames, no remainder", () => {
    const { samples, remainder } = int16ChunkToFloat32(new Uint8Array(0), pcm(0, 32767, -32768));
    expect(remainder.length).toBe(0);
    expect(samples.length).toBe(3);
    expect(samples[0]).toBeCloseTo(0, 5);
    expect(samples[1]).toBeCloseTo(0.99997, 4);
    expect(samples[2]).toBeCloseTo(-1, 5);
  });

  it("carries an odd trailing byte to the remainder", () => {
    const bytes = pcm(100, 200);          // 4 bytes
    const odd = new Uint8Array([...bytes, 0x7f]); // +1 stray byte
    const { samples, remainder } = int16ChunkToFloat32(new Uint8Array(0), odd);
    expect(samples.length).toBe(2);
    expect(remainder.length).toBe(1);
    expect(remainder[0]).toBe(0x7f);
  });

  it("combines a carried remainder with the next chunk", () => {
    // first chunk ends mid-sample (1 leftover byte: low byte of int16 = 0x10)
    const first = int16ChunkToFloat32(new Uint8Array(0), new Uint8Array([0x10]));
    expect(first.samples.length).toBe(0);
    expect(first.remainder.length).toBe(1);
    // next chunk supplies the high byte 0x27 -> int16 LE 0x2710 = 10000
    const second = int16ChunkToFloat32(first.remainder, new Uint8Array([0x27]));
    expect(second.samples.length).toBe(1);
    expect(second.samples[0]).toBeCloseTo(10000 / 32768, 5);
    expect(second.remainder.length).toBe(0);
  });
});

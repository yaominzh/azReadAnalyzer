import { describe, it, expect } from "vitest";
import { int16ChunkToFloat32, computeSeekAnchor, createBufferPlayer } from "./streamPlayer";

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

// Minimal fake Web Audio for createBufferPlayer (jsdom has no AudioContext).
function fakeCtx(currentTime = 0) {
  const ctx = {
    currentTime,
    destination: {},
    _lastSource: null as unknown as { playbackRate: { value: number }; started: { when: number; offset?: number } | null },
    createBufferSource() {
      const node = {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        started: null as { when: number; offset?: number } | null,
        connect() {},
        disconnect() {},
        start(when: number, offset?: number) { node.started = { when, offset }; },
        stop() {},
      };
      ctx._lastSource = node;
      return node;
    },
  };
  return ctx;
}
const fakeBuffer = (duration: number) => ({ duration } as unknown as AudioBuffer);

describe("createBufferPlayer", () => {
  it("is seekable with the buffer's duration", () => {
    const ctx = fakeCtx(10);
    const p = createBufferPlayer(ctx as unknown as AudioContext, fakeBuffer(20), () => 1);
    expect(p.isSeekable()).toBe(true);
    expect(p.synthDuration()).toBe(20);
  });

  it("seek() starts the source at the requested offset and sets the anchor", () => {
    const ctx = fakeCtx(10);
    const p = createBufferPlayer(ctx as unknown as AudioContext, fakeBuffer(20), () => 1);
    p.seek(5); // startAt = currentTime + 0.1 = 10.1
    expect(ctx._lastSource.started?.offset).toBeCloseTo(5, 6);
    expect(p.playbackStartTime()).toBeCloseTo(10.1 - 5, 6);        // start = startAt - pos/speed
    expect(p.playbackEndTime()).toBeCloseTo(10.1 + (20 - 5), 6);   // end = startAt + (total - pos)/speed
  });

  it("setSpeed() updates the live rate and recomputes the anchor from current position", () => {
    const ctx = fakeCtx(0);
    const p = createBufferPlayer(ctx as unknown as AudioContext, fakeBuffer(10), () => 1);
    p.seek(0);             // anchor: start 0.1, end 10.1
    ctx.currentTime = 5;   // ~4.9s elapsed at 1x
    p.setSpeed(2);
    expect(ctx._lastSource.playbackRate.value).toBe(2);
    // pos = (5-0.1)/(10.1-0.1)*10 = 4.9; new anchor: start = 5 - 4.9/2, end = 5 + (10-4.9)/2
    expect(p.playbackStartTime()).toBeCloseTo(2.55, 6);
    expect(p.playbackEndTime()).toBeCloseTo(7.55, 6);
  });
});

describe("computeSeekAnchor", () => {
  it("maps the progress formula to position/total at T = startAt", () => {
    const startAt = 5, pos = 3, speed = 1.5, total = 10;
    const { start, end } = computeSeekAnchor(startAt, pos, speed, total);
    const fractionAtStart = (startAt - start) / (end - start);
    expect(fractionAtStart).toBeCloseTo(pos / total, 6);
    expect(end - start).toBeCloseTo(total / speed, 6);
  });

  it("anchors position 0 so start === startAt", () => {
    const { start, end } = computeSeekAnchor(2, 0, 1, 8);
    expect(start).toBeCloseTo(2, 6);
    expect(end).toBeCloseTo(10, 6);
  });

  it("at 2x speed the clip span halves", () => {
    const { start, end } = computeSeekAnchor(0, 0, 2, 10);
    expect(end - start).toBeCloseTo(5, 6);
  });
});

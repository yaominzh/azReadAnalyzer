// Streaming TTS playback: assemble int16 LE PCM byte chunks into AudioBuffers
// and schedule them gaplessly. Once the stream is complete the decoded samples
// are retained so playback can seek to any offset (createBufferPlayer handles
// the single-complete-buffer case; the streaming player delegates to it once a
// seek happens). The play_tts fallback uses createBufferPlayer directly.

const SAMPLE_RATE = 24000;
const LOOKAHEAD = 0.1; // seconds — never schedule a chunk/seek in the past

/** Convert a byte chunk (prefixed by a carried remainder) into Float32 samples
 *  plus any leftover odd byte to carry into the next chunk. */
export function int16ChunkToFloat32(
  prev: Uint8Array,
  chunk: Uint8Array
): { samples: Float32Array; remainder: Uint8Array } {
  const buf = new Uint8Array(prev.length + chunk.length);
  buf.set(prev, 0);
  buf.set(chunk, prev.length);
  const frameCount = Math.floor(buf.length / 2);
  const samples = new Float32Array(frameCount);
  const dv = new DataView(buf.buffer, buf.byteOffset, frameCount * 2);
  for (let i = 0; i < frameCount; i++) {
    samples[i] = dv.getInt16(i * 2, true) / 32768;
  }
  return { samples, remainder: buf.slice(frameCount * 2) };
}

/** Virtual ctx-time anchor for a clip playing from `positionSec` at `speed`,
 *  started at ctx time `startAt`. With these bounds, the existing progress
 *  formula (T - start)/(end - start) equals absolutePosition/total. Pure. */
export function computeSeekAnchor(
  startAt: number,
  positionSec: number,
  speed: number,
  total: number
): { start: number; end: number } {
  return {
    start: startAt - positionSec / speed,
    end: startAt + (total - positionSec) / speed,
  };
}

export interface StreamPlayer {
  pushChunk(bytes: ArrayBuffer): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Seek to an absolute position in seconds (no-op unless isSeekable()). */
  seek(positionSec: number): void;
  /** Apply a new playback rate, updating the live source + anchor where applicable. */
  setSpeed(speed: number): void;
  /** True once a complete clip is retained and seeking is possible. */
  isSeekable(): boolean;
  /** Tell the streaming player the stream has fully arrived (enables seek). */
  markComplete(): void;
  /** Total clip seconds (grows during streaming; full once complete). */
  synthDuration(): number;
  /** ctx time the clip's position 0 maps to (null until playback has started). */
  playbackStartTime(): number | null;
  /** ctx time the clip ends — basis for progress/completion. */
  playbackEndTime(): number;
}

/** Plays one complete AudioBuffer with native offset seek. Used by the
 *  play_tts fallback and as the streaming player's delegate after a seek. */
export function createBufferPlayer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  getSpeed: () => number
): StreamPlayer {
  let src: AudioBufferSourceNode | null = null;
  let anchorStart = 0;
  let anchorEnd = 0;
  const total = buffer.duration;

  function currentPos(): number {
    const span = anchorEnd - anchorStart;
    if (span <= 0) return 0;
    const f = Math.min(1, Math.max(0, (ctx.currentTime - anchorStart) / span));
    return f * total;
  }

  function startFrom(positionSec: number): void {
    const pos = Math.min(total, Math.max(0, positionSec));
    if (src) { try { src.stop(); } catch { /* noop */ } src.disconnect(); }
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const speed = getSpeed();
    s.playbackRate.value = speed;
    s.connect(ctx.destination);
    const startAt = ctx.currentTime + LOOKAHEAD;
    s.start(startAt, pos);
    src = s;
    const a = computeSeekAnchor(startAt, pos, speed, total);
    anchorStart = a.start; anchorEnd = a.end;
  }

  return {
    pushChunk() { /* complete buffer: nothing to stream */ },
    pause() { ctx.suspend(); },
    resume() { ctx.resume(); },
    stop() { if (src) { try { src.stop(); } catch { /* noop */ } src.disconnect(); src = null; } },
    seek(positionSec) { startFrom(positionSec); },
    setSpeed(speed) {
      if (!src) return;
      const pos = currentPos();
      src.playbackRate.value = speed;
      const a = computeSeekAnchor(ctx.currentTime, pos, speed, total);
      anchorStart = a.start; anchorEnd = a.end;
    },
    isSeekable: () => true,
    markComplete() { /* already complete */ },
    synthDuration: () => total,
    playbackStartTime: () => (src ? anchorStart : null),
    playbackEndTime: () => anchorEnd,
  };
}

export function createStreamPlayer(ctx: AudioContext, getSpeed: () => number): StreamPlayer {
  let remainder: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let nextStartTime = 0;          // ctx time the next chunk will start
  let firstStartAt: number | null = null; // ctx time the first chunk starts
  const sources: AudioBufferSourceNode[] = [];

  // Retained audio for seek.
  const allSamples: Float32Array[] = [];
  let totalSamples = 0;
  let complete = false;

  // Single-source delegate, created lazily on first seek.
  let delegate: StreamPlayer | null = null;

  function totalDuration(): number { return totalSamples / SAMPLE_RATE; }

  function buildFullBuffer(): AudioBuffer {
    const buf = ctx.createBuffer(1, totalSamples, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    let off = 0;
    for (const s of allSamples) { ch.set(s, off); off += s.length; }
    return buf;
  }

  function stopStreamingSources(): void {
    for (const s of sources) { try { s.stop(); } catch { /* noop */ } s.disconnect(); }
    sources.length = 0;
  }

  function pushChunk(bytes: ArrayBuffer): void {
    if (delegate) return; // already in single-source mode
    const out = int16ChunkToFloat32(remainder, new Uint8Array(bytes));
    remainder = out.remainder as Uint8Array<ArrayBuffer>;
    if (out.samples.length === 0) return;

    allSamples.push(out.samples);
    totalSamples += out.samples.length;

    const buffer = ctx.createBuffer(1, out.samples.length, SAMPLE_RATE);
    buffer.copyToChannel(out.samples as Float32Array<ArrayBuffer>, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const speed = getSpeed();
    src.playbackRate.value = speed;
    src.connect(ctx.destination);

    if (firstStartAt === null) nextStartTime = ctx.currentTime + LOOKAHEAD;
    const startAt = Math.max(nextStartTime, ctx.currentTime + LOOKAHEAD);
    if (firstStartAt === null) firstStartAt = startAt;
    src.start(startAt);
    nextStartTime = startAt + buffer.duration / speed;
    sources.push(src);
  }

  function seek(positionSec: number): void {
    if (!complete || totalSamples === 0) return;
    if (!delegate) {
      stopStreamingSources();
      delegate = createBufferPlayer(ctx, buildFullBuffer(), getSpeed);
    }
    delegate.seek(positionSec);
  }

  function setSpeed(speed: number): void {
    // Delegate (post-seek) updates its live source + anchor. In chunk-streaming
    // mode getSpeed() already feeds the new rate to upcoming chunks; already
    // scheduled chunks keep their rate (documented contract).
    delegate?.setSpeed(speed);
  }

  function stop(): void {
    stopStreamingSources();
    delegate?.stop();
    delegate = null;
    remainder = new Uint8Array(0);
    firstStartAt = null;
    nextStartTime = 0;
    allSamples.length = 0;
    totalSamples = 0;
    complete = false;
  }

  return {
    pushChunk,
    pause() { ctx.suspend(); },
    resume() { ctx.resume(); },
    stop,
    seek,
    setSpeed,
    isSeekable: () => complete && totalSamples > 0,
    markComplete() { complete = true; },
    synthDuration: () => totalDuration(),
    playbackStartTime: () => (delegate ? delegate.playbackStartTime() : firstStartAt),
    playbackEndTime: () => (delegate ? delegate.playbackEndTime() : nextStartTime),
  };
}

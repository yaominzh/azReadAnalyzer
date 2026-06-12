// Streaming TTS playback: assemble int16 LE PCM byte chunks into AudioBuffers
// and schedule them gaplessly on a Web Audio context.

const SAMPLE_RATE = 24000;
const LOOKAHEAD = 0.1; // seconds — never schedule a chunk in the past

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

export interface StreamPlayer {
  pushChunk(bytes: ArrayBuffer): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** total audio seconds scheduled so far (duration label) */
  synthDuration(): number;
  /** ctx time the first chunk starts (null until the first chunk), and the ctx
   *  time the scheduled audio ends — the basis for progress/completion. */
  playbackStartTime(): number | null;
  playbackEndTime(): number;
}

export function createStreamPlayer(ctx: AudioContext, getSpeed: () => number): StreamPlayer {
  let remainder: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let nextStartTime = 0;          // ctx time the next chunk will start
  let firstStartAt: number | null = null; // ctx time the first chunk starts
  let scheduled = 0;              // total audio seconds scheduled
  const sources: AudioBufferSourceNode[] = [];

  function pushChunk(bytes: ArrayBuffer): void {
    const out = int16ChunkToFloat32(remainder, new Uint8Array(bytes));
    remainder = out.remainder as Uint8Array<ArrayBuffer>;
    if (out.samples.length === 0) return;

    const buffer = ctx.createBuffer(1, out.samples.length, SAMPLE_RATE);
    buffer.copyToChannel(out.samples as Float32Array<ArrayBuffer>, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const speed = getSpeed();
    src.playbackRate.value = speed;
    src.connect(ctx.destination);

    if (firstStartAt === null) nextStartTime = ctx.currentTime + LOOKAHEAD;
    // Underrun clamp: a stall must not schedule into the past.
    const startAt = Math.max(nextStartTime, ctx.currentTime + LOOKAHEAD);
    if (firstStartAt === null) firstStartAt = startAt;
    src.start(startAt);
    nextStartTime = startAt + buffer.duration / speed; // advance by actual played duration
    scheduled += buffer.duration;
    sources.push(src);
  }

  function pause(): void { ctx.suspend(); }
  function resume(): void { ctx.resume(); }

  function stop(): void {
    for (const s of sources) {
      try { s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
    sources.length = 0;
    remainder = new Uint8Array(0);
    firstStartAt = null;
    nextStartTime = 0;
    scheduled = 0;
  }

  return {
    pushChunk,
    pause,
    resume,
    stop,
    synthDuration: () => scheduled,
    playbackStartTime: () => firstStartAt,
    playbackEndTime: () => nextStartTime,
  };
}

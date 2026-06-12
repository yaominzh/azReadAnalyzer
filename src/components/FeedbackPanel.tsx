import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import type { DiffToken, PacingMetrics } from "../types";

// Replay the user's own recording (#3). Fetches the WAV via get_last_recording
// (raw bytes / ipc::Response) and plays it with HTML5 Audio. Object URLs are
// revoked on replace / end / unmount to avoid leaks (review #5 lifecycle rule).
function ReplayYourReading() {
  const addToast = useAppStore((s) => s.addToast);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  function cleanup() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }

  // Revoke on unmount.
  useEffect(() => cleanup, []);

  async function handleClick() {
    if (playing) {
      cleanup();
      setPlaying(false);
      return;
    }
    try {
      const buf = await invoke<ArrayBuffer>("get_last_recording");
      cleanup(); // revoke any prior audio/URL before starting a new one (TPM S3)
      const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "audio/wav" }));
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { cleanup(); setPlaying(false); };
      await audio.play();
      setPlaying(true);
    } catch (e) {
      cleanup();
      setPlaying(false);
      addToast(String(e), "error");
    }
  }

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 text-[11px] font-medium text-white/55 bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1 hover:bg-white/[0.1] hover:text-white/80 transition-colors"
    >
      <span aria-hidden>{playing ? "⏸" : "▶"}</span>
      <span>Your reading</span>
    </button>
  );
}

function PacingReadout({ pacing }: { pacing: PacingMetrics }) {
  // Honesty guardrail: WPM is always valid; pause/hesitation metrics are only
  // meaningful when ASR produced ≥2 segments. When not, show "—" and a note
  // rather than an authoritative (and possibly wrong) "0 pauses".
  const reliable = pacing.pausesReliable;
  const dash = (n: string | number) =>
    reliable ? <span className="text-indigo-300 font-medium">{n}</span> : <span className="text-white/30">—</span>;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-white/55">
        <span><span className="text-indigo-300 font-medium">{Math.round(pacing.wordsPerMinute)}</span> wpm</span>
        <span>{dash(pacing.pauseCount)} pauses</span>
        <span>{dash(pacing.longHesitations)} long hesitations</span>
        <span>{dash(`${Math.round(pacing.pauseRatio * 100)}%`)} pause ratio</span>
      </div>
      {!reliable && (
        <p className="mt-1 text-[10px] text-white/30 italic">
          Limited timing data — pause/hesitation metrics need a longer reading.
        </p>
      )}
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);

  return (
    <div className="relative w-16 h-16 flex-shrink-0">
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
        <circle
          cx="32" cy="32" r={r}
          fill="none"
          stroke="#6366f1"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ filter: "drop-shadow(0 0 4px rgba(99,102,241,0.6))", transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[14px] font-bold text-indigo-400">
        {score}
      </span>
    </div>
  );
}

function DiffView({ tokens }: { tokens: DiffToken[] }) {
  return (
    <div className="bg-black/25 border border-white/[0.06] rounded-lg p-3 text-[13px] leading-[1.8] mb-2.5">
      {tokens.map((t, i) => (
        <span
          key={i}
          className={
            t.type === "correct"
              ? "text-white/85"
              : t.type === "missed"
              ? // original word (the target you should have said) — green, readable
                "text-green-300 bg-green-500/15 rounded px-0.5 mx-0.5"
              : // what you said that's wrong/extra — red, struck out
                "line-through text-red-300 bg-red-500/20 rounded px-0.5 mx-0.5"
          }
        >
          {t.text}
        </span>
      ))}
    </div>
  );
}

export default function FeedbackPanel() {
  const feedback = useAppStore((s) => s.feedback);
  const clearFeedback = useAppStore((s) => s.clearFeedback);
  const setInputText = useAppStore((s) => s.setInputText);
  const clearCaptureImage = useAppStore((s) => s.clearCaptureImage);

  function handleNewText() {
    clearFeedback();
    setInputText("");
    clearCaptureImage();
    invoke("clear_session_media").catch(() => {});
  }

  if (!feedback) return null;

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06]">
      {/* Header with score (suppressed when LLM was unreachable) */}
      <div className="flex items-center gap-3 mb-3">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28">
          Feedback
        </p>
        {/* Replay the user's own recording (#3) */}
        <ReplayYourReading />
        {feedback.score !== null && (
          <div className="ml-auto flex items-center gap-3">
            <ScoreRing score={feedback.score} />
            <span className="text-[11px] text-white/30 leading-tight">
              Fluency<br />Score
            </span>
          </div>
        )}
      </div>

      {/* Pacing metrics */}
      <PacingReadout pacing={feedback.pacing} />

      {/* Diff view */}
      <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1.5">
        What you said vs original
      </p>
      <DiffView tokens={feedback.diff} />
      <div className="flex gap-4 mb-3">
        <span className="text-[10px] text-green-300">■ original (target)</span>
        <span className="text-[10px] text-red-300 line-through">said instead</span>
      </div>

      {/* LLM comments (empty when LLM unreachable → show a quiet notice instead) */}
      {feedback.score === null ? (
        <p className="text-[11px] text-white/35 italic mb-4">
          AI coach unavailable — showing content diff and pacing only.
        </p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {feedback.comments.map((c, i) => (
            <div
              key={i}
              className="flex gap-2 items-start p-2.5 rounded-lg bg-indigo-500/[0.06] border border-indigo-500/[0.12] text-[12px] text-white/65 leading-relaxed"
            >
              <span className="text-sm flex-shrink-0 mt-0.5">{c.icon}</span>
              {/* Plain text, not dangerouslySetInnerHTML — comment text is LLM
                  output and must not be injected as HTML. */}
              <span>{c.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={clearFeedback}
          className="flex-1 py-2 rounded-lg text-[12px] font-medium bg-gradient-to-br from-indigo-500 to-indigo-400 text-white shadow-[0_0_16px_rgba(99,102,241,0.3)] hover:shadow-[0_0_24px_rgba(99,102,241,0.5)] transition-all"
        >
          ⏺ Re-record
        </button>
        <button
          onClick={handleNewText}
          className="px-4 py-2 rounded-lg text-[12px] font-medium bg-white/[0.06] border border-white/[0.08] text-white/60 hover:bg-white/10 hover:text-white/85 transition-all"
        >
          New Text
        </button>
      </div>
    </div>
  );
}

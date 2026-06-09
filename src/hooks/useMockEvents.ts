import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";

const SAMPLE_TEXT =
  "The ability to communicate clearly in English is one of the most valuable skills you can develop.";

export function useMockEvents() {
  useEffect(() => {
    if (!import.meta.env.VITE_USE_MOCK) return;

    const store = useAppStore.getState();

    // Simulate text capture after 800ms
    const t1 = setTimeout(() => {
      store.setInputText(SAMPLE_TEXT);
    }, 800);

    // Simulate feedback after 3s
    const t2 = setTimeout(() => {
      store.setRecordingState("analyzing");
      setTimeout(() => {
        store.setFeedback({
          score: 87,
          transcription: "The ability to communicate clear in English is one of the most valuable skills.",
          diff: [
            { text: "The ability to communicate ", type: "correct" },
            { text: "clearly", type: "missed" },
            { text: "clear", type: "added" },
            { text: " in English is one of the most valuable skills", type: "correct" },
            { text: " you can develop", type: "missed" },
            { text: ".", type: "correct" },
          ],
          pacing: {
            wordsPerMinute: 142,
            articulationRate: 168,
            pauseCount: 6,
            totalPauseMs: 4200,
            pauseRatio: 0.21,
            longHesitations: 2,
            pausesReliable: true,
          },
          comments: [
            { icon: "🐢", text: "Your pace (142 wpm) is on the slow side for read-aloud — aim for 150–170." },
            { icon: "⏸️", text: "2 long hesitations and a 21% pause ratio. Try reading a full clause without stopping." },
            { icon: "✅", text: "Good rhythm on the opening clause — natural stress and pacing." },
          ],
        });
        store.setRecordingState("idle");
      }, 1200);
    }, 3000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
}

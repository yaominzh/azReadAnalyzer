import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/useAppStore";
import type {
  TextCapturedPayload,
  AudioLevelPayload,
  RecordingStatePayload,
  FeedbackReadyPayload,
} from "../types";

export function useTauriEvents() {
  const unlistenersRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (import.meta.env.VITE_USE_MOCK) return;

    let cancelled = false;

    async function setup(): Promise<boolean> {
      if (!(window as unknown as { __TAURI__?: unknown }).__TAURI__) return false;

      const store = useAppStore.getState();

      const u1 = await listen<TextCapturedPayload>("text-captured", (e) => {
        store.setInputText(e.payload.text);
      });

      const u2 = await listen<AudioLevelPayload>("audio-level", (e) => {
        store.setAudioLevel(e.payload.level);
      });

      const u3 = await listen<RecordingStatePayload>("recording-state", (e) => {
        store.setRecordingState(e.payload.state);
      });

      const u4 = await listen<FeedbackReadyPayload>("feedback-ready", (e) => {
        store.setFeedback(e.payload);
      });

      if (!cancelled) {
        unlistenersRef.current = [u1, u2, u3, u4];
        return true;
      }
      [u1, u2, u3, u4].forEach((u) => u());
      return false;
    }

    let attempts = 0;
    function trySetup() {
      setup().then((ok) => {
        if (!ok && !cancelled && ++attempts < 10) setTimeout(trySetup, 200);
      });
    }
    trySetup();

    return () => {
      cancelled = true;
      unlistenersRef.current.forEach((u) => u());
    };
  }, []);
}

import { vi } from "vitest";

const DEFAULT_SETTINGS = {
  llmBaseUrl: "http://127.0.0.1:8002/v1",
  llmModel: "default",
  llmApiKey: "",
  llmTimeoutSecs: 45,
};

export class Channel<T = unknown> {
  onmessage: (msg: T) => void = () => {};
  // Tauri serializes a Channel to an IPC id string; a stub is enough for tests.
  toJSON() { return "__CHANNEL__"; }
}

export const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "get_settings") return DEFAULT_SETTINGS;
  if (cmd === "apply_settings") return undefined; // Ok(())
  if (cmd === "play_tts_stream") return undefined; // resolves; no chunks in tests
  if (cmd === "stop_tts_stream") return undefined;
  return undefined;
});
export const listen = vi.fn().mockResolvedValue(() => {});
export const emit = vi.fn().mockResolvedValue(undefined);

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { FROST_PRESETS, FROST_DEFAULT, loadFrost, saveFrost, type Frost } from "../lib/frost";
import type { AppSettings } from "../types";

function isLoopback(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return true; // unparseable → don't show the off-device warning (validation handles it)
  }
}

const BUILTIN_SETTINGS: AppSettings = {
  llmBaseUrl: "http://127.0.0.1:8002/v1",
  llmModel: "default",
  llmApiKey: "",
  llmTimeoutSecs: 45,
};

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const addToast = useAppStore((s) => s.addToast);
  const [frost, setFrost] = useState<Frost>(() => loadFrost());
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [confirmedOffDevice, setConfirmedOffDevice] = useState(false);

  // Load Rust-backed connection settings on open. Browser mock mode has no
  // Tauri backend (review #4) → use built-in defaults instead of invoke.
  useEffect(() => {
    const p = import.meta.env.VITE_USE_MOCK
      ? Promise.resolve(BUILTIN_SETTINGS)
      : invoke<AppSettings>("get_settings");
    p.then(setSettings).catch(() => {});
  }, []);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function setPreset(p: Frost) { setFrost(p); saveFrost(p); }      // instant + persist
  function setAlpha(alpha: number) { const f = { ...frost, alpha }; setFrost(f); saveFrost(f); }
  function setBlur(blur: number) { const f = { ...frost, blur }; setFrost(f); saveFrost(f); }

  const nonLocal = settings ? !isLoopback(settings.llmBaseUrl) : false;

  async function applyConnection() {
    if (!settings) return;
    // (review #1) non-loopback requires explicit confirmation before Apply.
    if (nonLocal && !confirmedOffDevice) {
      addToast("Confirm the off-device warning before applying", "error");
      return;
    }
    if (import.meta.env.VITE_USE_MOCK) { addToast("Settings saved (mock)", "info"); onClose(); return; }
    try {
      await invoke("apply_settings", { settings });
      addToast("Settings saved", "info");
      onClose();
    } catch (e) {
      addToast(String(e), "error");
    }
  }

  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}>
      <div onClick={(e) => e.stopPropagation()} className="w-[440px] max-h-[85vh] overflow-y-auto rounded-xl border border-white/10 bg-[#0c0c0c]/95 p-5 text-white/80">
        <p className="text-[13px] font-semibold tracking-wider uppercase text-white/40 mb-4">Settings</p>

        {/* Appearance */}
        <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2">Appearance</p>
        <div className="flex gap-2 mb-3">
          {(Object.keys(FROST_PRESETS) as Array<keyof typeof FROST_PRESETS>).map((name) => (
            <button key={name} onClick={() => setPreset(FROST_PRESETS[name])}
              className="px-3 py-1.5 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 hover:bg-white/[0.12]">
              {name}
            </button>
          ))}
        </div>
        {/* (review #7) sliders live under an expandable Advanced disclosure */}
        <details className="mb-3">
          <summary className="text-[11px] text-white/45 cursor-pointer select-none">Advanced</summary>
          <label className="block text-[11px] text-white/45 mt-2 mb-3">
            Opacity {Math.round(frost.alpha * 100)}%
            <input type="range" min={5} max={95} value={Math.round(frost.alpha * 100)}
              onChange={(e) => setAlpha(Number(e.target.value) / 100)} className="w-full" />
          </label>
          <label className="block text-[11px] text-white/45 mb-2">
            Blur {frost.blur}px
            <input type="range" min={0} max={40} value={frost.blur}
              onChange={(e) => setBlur(Number(e.target.value))} className="w-full" />
          </label>
        </details>
        <button onClick={() => setPreset(FROST_DEFAULT)} className="text-[11px] text-white/35 hover:text-white/60 mb-4">Reset appearance</button>

        {/* Connection */}
        <p className="text-[10px] font-semibold tracking-widest uppercase text-white/28 mb-2 mt-2 border-t border-white/[0.06] pt-4">Connection</p>
        {settings && (
          <div className="flex flex-col gap-2.5">
            <label className="text-[11px] text-white/45">oMLX Base URL
              <input aria-label="oMLX Base URL" type="text" value={settings.llmBaseUrl}
                onChange={(e) => { setSettings({ ...settings, llmBaseUrl: e.target.value }); setConfirmedOffDevice(false); }}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
            {nonLocal && (
              <div className="text-[11px] text-amber-300/90">
                <p>⚠ This sends your reading text off this machine (not 127.0.0.1).</p>
                <label className="flex items-center gap-1.5 mt-1 text-amber-200/90">
                  <input type="checkbox" checked={confirmedOffDevice}
                    onChange={(e) => setConfirmedOffDevice(e.target.checked)} />
                  I understand and want to use this remote endpoint
                </label>
              </div>
            )}
            <label className="text-[11px] text-white/45">Model
              <input aria-label="Model" type="text" value={settings.llmModel}
                onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
            <label className="text-[11px] text-white/45">API key
              <input aria-label="API key" type="password" value={settings.llmApiKey}
                onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
            <label className="text-[11px] text-white/45">Timeout (s)
              <input aria-label="Timeout (s)" type="number" min={5} max={300} value={settings.llmTimeoutSecs}
                onChange={(e) => setSettings({ ...settings, llmTimeoutSecs: Number(e.target.value) })}
                className="w-full mt-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80" />
            </label>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <button onClick={applyConnection} disabled={nonLocal && !confirmedOffDevice}
            className="flex-1 py-2 rounded-lg text-[12px] font-medium bg-gradient-to-br from-indigo-500 to-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed">Apply</button>
          <button onClick={() => { setSettings(BUILTIN_SETTINGS); setConfirmedOffDevice(false); }}
            className="px-3 py-2 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 text-white/60">Defaults</button>
          <button onClick={onClose} className="px-3 py-2 rounded-lg text-[12px] bg-white/[0.06] border border-white/10 text-white/60">Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

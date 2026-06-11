import { useState, useEffect } from "react";
import { loadFrost, applyFrost } from "./lib/frost";
import { invoke } from "@tauri-apps/api/core";
import SettingsPanel from "./components/SettingsPanel";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Group, Panel, Separator } from "react-resizable-panels";
import TextInputPanel from "./components/TextInputPanel";
import CaptureThumbnail from "./components/CaptureThumbnail";
import CaptureControls from "./components/CaptureControls";
import PlaybackControls from "./components/PlaybackControls";
import RecordingPanel from "./components/RecordingPanel";
import FeedbackPanel from "./components/FeedbackPanel";
import Toasts from "./components/Toasts";
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useMockEvents } from "./hooks/useMockEvents";

export default function App() {
  // Window starts always-on-top (tauri.conf.json alwaysOnTop: true); toggle flips it.
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useTauriEvents();
  useMockEvents();

  useEffect(() => {
    applyFrost(loadFrost());
  }, []);

  function toggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    invoke("set_always_on_top", { enabled: next }).catch(() => {});
  }

  // Window controls. getCurrentWindow() dereferences __TAURI_INTERNALS__ at
  // call time and throws outside the Tauri webview (browser/jsdom), so call it
  // lazily inside each handler, guarded. (TPM M1)
  const winClose = () => { try { getCurrentWindow().close(); } catch { /* not in Tauri */ } };
  const winMinimize = () => { try { getCurrentWindow().minimize(); } catch { /* not in Tauri */ } };
  const winZoom = () => { try { getCurrentWindow().toggleMaximize(); } catch { /* not in Tauri */ } };
  // Interactive children of the drag region must not let the parent swallow
  // their mousedown. (TPM M3)
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="flex flex-col h-screen rounded-xl overflow-hidden border border-white/10 az-frost">
      {/* Custom titlebar — whole bar drags the window (data-tauri-drag-region) */}
      <div
        data-tauri-drag-region
        className="titlebar flex items-center justify-between px-4 h-10 bg-white/[0.03] border-b border-white/[0.07] flex-shrink-0"
      >
        {/* macOS traffic lights — functional */}
        <div className="group flex gap-1.5">
          <button
            aria-label="Close"
            onMouseDown={stop}
            onClick={winClose}
            className="w-3 h-3 rounded-full bg-[#ff5f57] flex items-center justify-center text-black/60 text-[8px] leading-none"
          >
            <span className="opacity-0 group-hover:opacity-100">×</span>
          </button>
          <button
            aria-label="Minimize"
            onMouseDown={stop}
            onClick={winMinimize}
            className="w-3 h-3 rounded-full bg-[#febc2e] flex items-center justify-center text-black/60 text-[8px] leading-none"
          >
            <span className="opacity-0 group-hover:opacity-100">−</span>
          </button>
          <button
            aria-label="Zoom"
            onMouseDown={stop}
            onClick={winZoom}
            className="w-3 h-3 rounded-full bg-[#28c840] flex items-center justify-center text-black/60 text-[8px] leading-none"
          >
            <span className="opacity-0 group-hover:opacity-100">+</span>
          </button>
        </div>
        <span className="text-[13px] font-medium text-white/40 tracking-wider">
          azReadAnalyzer
        </span>
        <div className="flex items-center gap-3">
          <button
            onMouseDown={stop}
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            className="text-white/30 hover:text-white/60 transition-colors text-[14px]"
          >
            ⚙
          </button>
          <button
            onMouseDown={stop}
            onClick={toggleAlwaysOnTop}
            className="flex items-center gap-2 text-[11px] text-white/30 hover:text-white/60 transition-colors"
          >
            <span>Always on top</span>
            <div className={`w-7 h-4 rounded-full relative transition-colors ${alwaysOnTop ? "bg-[#6366f1]/50" : "bg-white/10"}`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${alwaysOnTop ? "left-3.5" : "left-0.5"}`} />
            </div>
          </button>
        </div>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 p-3 overflow-hidden">
        <Group orientation="horizontal" className="gap-2.5 h-full">
          <Panel id="left" defaultSize={50} minSize={30}>
            <div className="h-full rounded-xl bg-white/[0.02] border border-white/[0.08] flex flex-col">
              <p className="px-3.5 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-white/30 border-b border-white/[0.06]">
                Text Input
              </p>
              <div className="flex-1 p-4 flex flex-col min-h-0">
                <TextInputPanel />
                <CaptureThumbnail />
                <CaptureControls />
              </div>
            </div>
          </Panel>
          <Separator className="w-1.5 rounded-full bg-white/[0.04] hover:bg-white/10 transition-colors" />
          <Panel id="right" defaultSize={50} minSize={30}>
            <div className="h-full rounded-xl bg-white/[0.02] border border-white/[0.08] flex flex-col overflow-y-auto">
              <p className="px-3.5 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-white/30 border-b border-white/[0.06]">
                Practice
              </p>
              <div className="p-3.5 flex flex-col gap-0 overflow-y-auto flex-1">
                <PlaybackControls />
                <RecordingPanel />
                <FeedbackPanel />
              </div>
            </div>
          </Panel>
        </Group>
      </div>

      <Toasts />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

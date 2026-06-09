import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Group, Panel, Separator } from "react-resizable-panels";
import TextInputPanel from "./components/TextInputPanel";
import CaptureControls from "./components/CaptureControls";
import Toasts from "./components/Toasts";
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useMockEvents } from "./hooks/useMockEvents";

export default function App() {
  // Window starts always-on-top (tauri.conf.json alwaysOnTop: true); toggle flips it.
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);

  useTauriEvents();
  useMockEvents();

  function toggleAlwaysOnTop() {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    invoke("set_always_on_top", { enabled: next }).catch(() => {});
  }

  return (
    <div className="flex flex-col h-screen bg-[#080808]">
      {/* Custom titlebar */}
      <div className="titlebar flex items-center justify-between px-4 h-10 bg-black/60 border-b border-white/[0.07] flex-shrink-0">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="text-[13px] font-medium text-white/40 tracking-wider">
          azReadAnalyzer
        </span>
        <button
          onClick={toggleAlwaysOnTop}
          className="flex items-center gap-2 text-[11px] text-white/30 hover:text-white/60 transition-colors"
        >
          <span>Always on top</span>
          <div className={`w-7 h-4 rounded-full relative transition-colors ${alwaysOnTop ? "bg-[#6366f1]/50" : "bg-white/10"}`}>
            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${alwaysOnTop ? "left-3.5" : "left-0.5"}`} />
          </div>
        </button>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 p-3 overflow-hidden">
        <Group orientation="horizontal" className="gap-2.5 h-full">
          <Panel id="left" defaultSize={50} minSize={30}>
            <div className="h-full rounded-xl bg-white/[0.04] border border-white/[0.08] flex flex-col">
              <p className="px-3.5 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-white/30 border-b border-white/[0.06]">
                Text Input
              </p>
              <div className="flex-1 p-4 flex flex-col min-h-0">
                <TextInputPanel />
                <CaptureControls />
              </div>
            </div>
          </Panel>
          <Separator className="w-1.5 rounded-full bg-white/[0.04] hover:bg-white/10 transition-colors" />
          <Panel id="right" defaultSize={50} minSize={30}>
            <div className="h-full rounded-xl bg-white/[0.04] border border-white/[0.08] flex flex-col overflow-y-auto">
              <p className="px-3.5 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-white/30 border-b border-white/[0.06]">
                Practice
              </p>
              <div className="p-3.5 flex flex-col gap-0 overflow-y-auto flex-1">
                {/* PlaybackControls + RecordingPanel + FeedbackPanel go here (iterations 2-3) */}
              </div>
            </div>
          </Panel>
        </Group>
      </div>

      <Toasts />
    </div>
  );
}

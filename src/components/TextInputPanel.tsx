import { useAppStore } from "../store/useAppStore";

export default function TextInputPanel() {
  const inputText = useAppStore((s) => s.inputText);
  const setInputText = useAppStore((s) => s.setInputText);

  return (
    <textarea
      className="flex-1 w-full bg-transparent border-none outline-none resize-none text-[15px] leading-relaxed text-white/85 placeholder-white/20 p-0"
      placeholder="Paste text or capture a screenshot to begin…"
      value={inputText}
      onChange={(e) => setInputText(e.target.value)}
    />
  );
}

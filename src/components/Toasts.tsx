import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";

export default function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => removeToast(t.id), 5000)
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => removeToast(t.id)}
          className={`px-3.5 py-2.5 rounded-lg text-[13px] cursor-pointer backdrop-blur-md border shadow-lg ${
            t.type === "error"
              ? "bg-red-500/15 border-red-500/30 text-red-200"
              : "bg-white/[0.08] border-white/15 text-white/80"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

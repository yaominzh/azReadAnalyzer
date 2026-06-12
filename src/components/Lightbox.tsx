import { useEffect } from "react";
import { createPortal } from "react-dom";

// Full-screen image lightbox (#4). Portaled to document.body because the app
// root has backdrop-blur + overflow-hidden + rounded corners, which would
// otherwise clip/contain a fixed overlay rendered inside it (TPM Q1).
export default function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out"
    >
      <img
        src={url}
        alt="Captured image"
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl cursor-default"
      />
    </div>,
    document.body
  );
}

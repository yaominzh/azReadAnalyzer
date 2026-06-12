import { useState } from "react";
import { useAppStore } from "../store/useAppStore";
import Lightbox from "./Lightbox";

// Thumbnail of the captured image (screenshot or pasted image) (#4). Click to
// open the full-size lightbox — ChatGPT-style. Rendered only when a capture
// image exists; absent for plain text paste.
export default function CaptureThumbnail() {
  const captureImageUrl = useAppStore((s) => s.captureImageUrl);
  const [open, setOpen] = useState(false);

  if (!captureImageUrl) return null;

  return (
    <div className="mt-3 flex-shrink-0">
      <button
        onClick={() => setOpen(true)}
        aria-label="View captured image"
        className="block h-16 rounded-lg overflow-hidden border border-white/15 hover:border-white/35 transition-colors"
      >
        <img src={captureImageUrl} alt="Captured" className="h-full w-auto object-cover" />
      </button>
      {open && <Lightbox url={captureImageUrl} onClose={() => setOpen(false)} />}
    </div>
  );
}

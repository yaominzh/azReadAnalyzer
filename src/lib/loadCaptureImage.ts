import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

// Fetch the captured image PNG (raw bytes via get_capture_image) and hand a
// fresh object URL to the store, which owns its lifecycle (#4). Errors → toast.
export async function loadCaptureImage(): Promise<void> {
  try {
    const buf = await invoke<ArrayBuffer>("get_capture_image");
    const url = URL.createObjectURL(new Blob([new Uint8Array(buf)], { type: "image/png" }));
    useAppStore.getState().setCaptureImageUrl(url);
  } catch (e) {
    useAppStore.getState().addToast(String(e), "error");
  }
}

import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom does not implement these; the store revokes object URLs on replace/clear.
if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:mock");
if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();

// Node 25 ships a built-in localStorage (Web Storage API) that has no .clear()/.setItem()
// unless the process is launched with --localstorage-file. The jsdom environment in vitest
// provides a proper localStorage on its window object but populateGlobal() skips it because
// 'localStorage' is not in vitest's KEYS list. Polyfill it here so the jsdom instance wins.
if (typeof localStorage === "undefined" || typeof localStorage.clear !== "function") {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => { storage.clear(); },
      get length() { return storage.size; },
      key: (i: number) => [...storage.keys()][i] ?? null,
    },
    configurable: true,
    writable: true,
  });
}

vi.mock("@tauri-apps/api/core", async () => {
  const m = await import("./__mocks__/@tauri-apps/api/index");
  return { invoke: m.invoke, Channel: m.Channel };
});

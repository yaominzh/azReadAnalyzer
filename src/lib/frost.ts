export interface Frost {
  alpha: number; // background opacity 0.05–0.95
  blur: number;  // backdrop blur px 0–40
}

export const FROST_DEFAULT: Frost = { alpha: 0.55, blur: 16 };

export const FROST_PRESETS = {
  Solid: { alpha: 1.0, blur: 0 }, // fully opaque — no desktop showing through
  Frosted: { alpha: 0.55, blur: 16 },
  Glass: { alpha: 0.25, blur: 28 },
} as const satisfies Record<string, Frost>;

const KEY_ALPHA = "az.frost.alpha";
const KEY_BLUR = "az.frost.blur";

export const clampAlpha = (n: number): number => Math.min(1, Math.max(0.05, n));
export const clampBlur = (n: number): number => Math.min(40, Math.max(0, n));

export function loadFrost(): Frost {
  const a = parseFloat(localStorage.getItem(KEY_ALPHA) ?? "");
  const b = parseFloat(localStorage.getItem(KEY_BLUR) ?? "");
  return {
    alpha: Number.isFinite(a) ? clampAlpha(a) : FROST_DEFAULT.alpha,
    blur: Number.isFinite(b) ? clampBlur(b) : FROST_DEFAULT.blur,
  };
}

// Apply to the live DOM via CSS variables (the runtime source of truth).
export function applyFrost(f: Frost): void {
  const root = document.documentElement;
  root.style.setProperty("--az-bg-alpha", String(clampAlpha(f.alpha)));
  root.style.setProperty("--az-blur", `${clampBlur(f.blur)}px`);
}

export function saveFrost(f: Frost): void {
  const safe = { alpha: clampAlpha(f.alpha), blur: clampBlur(f.blur) };
  localStorage.setItem(KEY_ALPHA, String(safe.alpha));
  localStorage.setItem(KEY_BLUR, String(safe.blur));
  applyFrost(safe);
}

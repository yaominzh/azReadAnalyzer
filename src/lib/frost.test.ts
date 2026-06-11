import { describe, it, expect, beforeEach } from "vitest";
import { loadFrost, saveFrost, FROST_DEFAULT, FROST_PRESETS, clampAlpha, clampBlur } from "./frost";

describe("frost", () => {
  beforeEach(() => localStorage.clear());

  it("clamps alpha and blur to range", () => {
    expect(clampAlpha(2)).toBe(0.95);
    expect(clampAlpha(0)).toBe(0.05);
    expect(clampBlur(99)).toBe(40);
    expect(clampBlur(-5)).toBe(0);
  });

  it("loadFrost returns defaults when storage is empty", () => {
    expect(loadFrost()).toEqual(FROST_DEFAULT);
  });

  it("loadFrost falls back to defaults on garbage", () => {
    localStorage.setItem("az.frost.alpha", "notnum");
    localStorage.setItem("az.frost.blur", "");
    expect(loadFrost()).toEqual(FROST_DEFAULT);
  });

  it("saveFrost persists clamped values and loadFrost reads them", () => {
    saveFrost({ alpha: 2, blur: 99 });
    expect(loadFrost()).toEqual({ alpha: 0.95, blur: 40 });
  });

  it("Frosted preset equals the default", () => {
    expect(FROST_PRESETS.Frosted).toEqual(FROST_DEFAULT);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import SettingsPanel from "../SettingsPanel";
import { loadFrost } from "../../lib/frost";
import { invoke } from "@tauri-apps/api/core";

describe("SettingsPanel", () => {
  // (review #5) `vi` is used here (clears mock call history between tests so the
  // confirm-gate assertion below is reliable); clearAllMocks keeps impls.
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

  it("renders Appearance presets and Connection fields", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /frosted/i })).toBeInTheDocument();
    // Connection fields populate from get_settings
    await waitFor(() => expect(screen.getByLabelText(/oMLX Base URL/i)).toHaveValue("http://127.0.0.1:8002/v1"));
  });

  it("clicking the Glass preset persists frost", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /glass/i }));
    expect(loadFrost()).toEqual({ alpha: 0.25, blur: 28 });
  });

  it("warns when a non-loopback host is entered", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const url = await screen.findByLabelText(/oMLX Base URL/i);
    await userEvent.clear(url);
    await userEvent.type(url, "http://192.168.1.50:8002/v1");
    expect(screen.getByText(/sends your reading text off this machine/i)).toBeInTheDocument();
  });

  it("Apply calls apply_settings (loopback default, no confirm needed)", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    await screen.findByLabelText(/oMLX Base URL/i);
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("apply_settings", expect.objectContaining({ settings: expect.any(Object) }))
    );
  });

  it("does NOT apply a non-loopback URL until confirmed (review #1)", async () => {
    render(<SettingsPanel onClose={() => {}} />);
    const url = await screen.findByLabelText(/oMLX Base URL/i);
    await userEvent.clear(url);
    await userEvent.type(url, "http://192.168.1.50:8002/v1");
    // Apply is disabled until confirm → clicking does nothing.
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    expect(invoke).not.toHaveBeenCalledWith("apply_settings", expect.anything());
    // Confirm, then Apply goes through.
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("apply_settings", expect.objectContaining({ settings: expect.any(Object) }))
    );
  });
});

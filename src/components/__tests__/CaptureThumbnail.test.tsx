import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import CaptureThumbnail from "../CaptureThumbnail";

describe("CaptureThumbnail", () => {
  beforeEach(() => useAppStore.setState({ captureImageUrl: null }));

  it("renders nothing when no capture image", () => {
    const { container } = render(<CaptureThumbnail />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a thumbnail image when a capture image exists", () => {
    useAppStore.setState({ captureImageUrl: "blob:abc" });
    render(<CaptureThumbnail />);
    expect(screen.getByAltText("Captured")).toBeInTheDocument();
  });

  it("opens the lightbox on click and closes on Escape", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ captureImageUrl: "blob:abc" });
    render(<CaptureThumbnail />);

    expect(screen.queryByAltText("Captured image")).not.toBeInTheDocument(); // lightbox closed
    await user.click(screen.getByRole("button", { name: /view captured image/i }));
    expect(screen.getByAltText("Captured image")).toBeInTheDocument();       // lightbox open

    await user.keyboard("{Escape}");
    expect(screen.queryByAltText("Captured image")).not.toBeInTheDocument();  // closed
  });
});

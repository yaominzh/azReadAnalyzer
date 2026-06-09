import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../store/useAppStore";
import TextInputPanel from "../TextInputPanel";

describe("TextInputPanel", () => {
  beforeEach(() => useAppStore.setState({ inputText: "" }));

  it("renders placeholder when empty", () => {
    render(<TextInputPanel />);
    expect(screen.getByPlaceholderText(/paste text or capture/i)).toBeInTheDocument();
  });

  it("displays store inputText", () => {
    useAppStore.setState({ inputText: "hello world" });
    render(<TextInputPanel />);
    expect(screen.getByDisplayValue("hello world")).toBeInTheDocument();
  });

  it("updates store on user edit", async () => {
    render(<TextInputPanel />);
    const ta = screen.getByPlaceholderText(/paste text or capture/i);
    await userEvent.type(ta, "test");
    expect(useAppStore.getState().inputText).toContain("test");
  });
});

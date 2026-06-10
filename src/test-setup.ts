import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom does not implement these; the store revokes object URLs on replace/clear.
if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:mock");
if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();

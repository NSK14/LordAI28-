import { describe, expect, it } from "vitest";
import { detectImageIntent } from "./image-intent";

describe("image intent detection", () => {
  it.each([
    "Generate a futuristic city",
    "Make this image look like anime",
    "Remove the background",
    "Upscale this image",
    "Create a logo",
    "Generate four variations",
  ])("recognizes %s", (prompt) => {
    expect(detectImageIntent(prompt)).toBe(true);
  });

  it.each([
    "Explain how to generate a futuristic city",
    "What is background removal?",
    "Describe anime image composition",
  ])("keeps explanatory requests in chat: %s", (prompt) => {
    expect(detectImageIntent(prompt)).toBe(false);
  });
});

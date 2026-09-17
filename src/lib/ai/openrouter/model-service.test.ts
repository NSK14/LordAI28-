import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AI } from "@/lib/ai/config";
import { streamChat } from "@/lib/ai/gateway";
import { resetFreeModelCacheForTests, resolveFreeModel } from "@/lib/ai/openrouter/model-service";

describe("dynamic free OpenRouter routing", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    resetFreeModelCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetFreeModelCacheForTests();
  });

  it("uses the best free model for the requested mode and includes the free-only routing constraint", async () => {
    const fetchMock = vi.fn(async () => {
      const payload = {
        data: [
          { id: "openai/gpt-oss-20b:free", name: "GPT OSS 20B", context_length: 128000 },
          { id: "google/gemma-3-27b-it:free", name: "Gemma 3 27B", context_length: 128000 },
        ],
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const selection = await resolveFreeModel("coding", "test-key", fetchMock as typeof fetch);

    expect(selection.available).toBe(true);
    expect(selection.modelId).toBe("openai/gpt-oss-20b:free");
  });

  it("streams with openrouter/auto without an invalid wildcard model list", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBe(AI.OPENROUTER_MODEL);
      expect(body.models).toBeUndefined();
      expect(body.max_tokens).toBe(512);
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const response = streamChat([{ role: "user", content: "hello" }], "coding");
    const output = await response.text();

    expect(output).toContain("hello");
  });
});

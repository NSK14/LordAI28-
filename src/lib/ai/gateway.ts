import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { DEFAULT_MODEL_ID } from "./models";
import type { ChatRequest, ChatResponse } from "./types";

const PLACEHOLDER_TEXT = "AI providers are temporarily unavailable while the gateway is being rebuilt.";

export async function sendChat(_request: ChatRequest): Promise<ChatResponse> {
  return { text: PLACEHOLDER_TEXT, modelId: DEFAULT_MODEL_ID };
}

export function streamChat(_request: ChatRequest): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "text-start", id: "placeholder" });
      writer.write({ type: "text-delta", id: "placeholder", delta: PLACEHOLDER_TEXT });
      writer.write({ type: "text-end", id: "placeholder" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
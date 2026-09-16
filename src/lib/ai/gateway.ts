import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getAIConfig, AIConfigurationError } from "./config";
import { OpenRouterClient } from "./client";
import { normalizeOpenRouterError, OpenRouterError } from "./errors";
import { MODELS } from "./models";
import type { ChatMessage } from "./types";

export function streamChat(messages: readonly ChatMessage[], signal?: AbortSignal): Response {
  const startedAt = Date.now();

  console.info("Model request started", { model: MODELS.DEFAULT });

  let client: OpenRouterClient;
  try {
    const config = getAIConfig();
    client = new OpenRouterClient(config.openRouterApiKey);
  } catch (error) {
    const message = error instanceof AIConfigurationError ? error.message : "OpenRouter is temporarily unavailable.";
    console.error("Model request error", { model: MODELS.DEFAULT, error: message });
    console.info("Model request completed", {
      model: MODELS.DEFAULT,
      duration: Date.now() - startedAt,
      status: "error",
    });
    throw error;
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const messageId = crypto.randomUUID();
      let status = "completed";
      writer.write({ type: "text-start", id: messageId });

      try {
        for await (const token of client.streamChat(messages, MODELS.DEFAULT, signal)) {
          writer.write({ type: "text-delta", id: messageId, delta: token });
        }
        writer.write({ type: "text-end", id: messageId });
      } catch (error) {
        const normalized = normalizeOpenRouterError(error);
        status = "error";
        writer.write({ type: "error", errorText: normalized.message });
        console.error("Model request error", {
          model: MODELS.DEFAULT,
          error: normalized.message,
        });
      } finally {
        console.info("Model request completed", {
          model: MODELS.DEFAULT,
          duration: Date.now() - startedAt,
          status,
        });
      }
    },
    onError: (error) => normalizeOpenRouterError(error).message,
  });

  return createUIMessageStreamResponse({ stream });
}

export function isAIConfigurationError(error: unknown): error is AIConfigurationError {
  return error instanceof AIConfigurationError;
}

export function isOpenRouterError(error: unknown): error is OpenRouterError {
  return error instanceof OpenRouterError;
}

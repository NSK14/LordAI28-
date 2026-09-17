import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { AI, getAIConfig, AIConfigurationError } from "./config";
import { OpenRouterClient } from "./client";
import { normalizeOpenRouterError, OpenRouterError } from "./errors";
import type { LordMode } from "./models";
import { resolveOpenRouterRoute } from "./openrouter/router";
import { getModePrompt } from "./openrouter/prompts";
import type { ChatMessage } from "./types";

export function streamChat(
  messages: readonly ChatMessage[],
  modeOrSignal?: LordMode | AbortSignal,
  signal?: AbortSignal,
): Response {
  const startedAt = Date.now();
  const mode = typeof modeOrSignal === "string" ? modeOrSignal : "balanced";
  const requestSignal =
    typeof modeOrSignal === "object" && modeOrSignal !== null && "aborted" in modeOrSignal
      ? modeOrSignal
      : signal;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const messageId = crypto.randomUUID();
      let status = "completed";
      let resolvedModel = AI.OPENROUTER_MODEL;
      let selectedModelId: string | undefined;
      let routeModels: readonly [string] | undefined;

      try {
        const config = getAIConfig();
        const route = await resolveOpenRouterRoute(mode, config.openRouterApiKey);
        resolvedModel = route.model;
        selectedModelId = route.selectedModelId;
        routeModels = route.models;

        if (import.meta.env.DEV) {
          console.info("OpenRouter free model resolved", {
            mode,
            model: resolvedModel,
            selectedModelId,
            models: route.models,
          });
        }
      } catch (error) {
        const message =
          error instanceof AIConfigurationError
            ? error.message
            : "OpenRouter is temporarily unavailable.";
        console.error("Model request error", { mode, error: message });
        writer.write({ type: "error", errorText: message });
        return;
      }

      writer.write({ type: "text-start", id: messageId });

      try {
        const client = new OpenRouterClient(getAIConfig().openRouterApiKey);
        const promptMessage = [
          { role: "system" as const, content: getModePrompt(mode) },
          ...messages,
        ];
        if (import.meta.env.DEV) {
          console.info("Model request started", { model: resolvedModel, mode, selectedModelId });
        }

        for await (const token of client.streamChat(
          promptMessage,
          resolvedModel,
          routeModels,
          requestSignal,
        )) {
          writer.write({ type: "text-delta", id: messageId, delta: token });
        }
        writer.write({ type: "text-end", id: messageId });
      } catch (error) {
        const normalized = normalizeOpenRouterError(error);
        status = "error";
        writer.write({ type: "error", errorText: normalized.message });
        console.error("Model request error", { mode, error: normalized.message });
      } finally {
        if (import.meta.env.DEV) {
          console.info("Model request completed", {
            model: resolvedModel,
            mode,
            selectedModelId,
            duration: Date.now() - startedAt,
            status,
          });
        }
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

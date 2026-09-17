import { createFileRoute } from "@tanstack/react-router";
import type { UIMessage } from "ai";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import { streamChat, isAIConfigurationError, isOpenRouterError } from "@/lib/ai/gateway";
import { OpenRouterError } from "@/lib/ai/errors";
import type { ChatMessage } from "@/lib/ai/types";
import { apiErrorResponse } from "@/lib/api-error";
import { buildMemoryPrompt } from "./-memory";
import { ChatRequestSchema } from "./-schema";

export function createChatRoute() {
  return createFileRoute("/api/chat")({
    server: {
      middleware: [requireSupabaseRequestAuth],
      handlers: {
        POST: async ({ request, context }) => {
          const requestId = crypto.randomUUID();
          let rawBody: unknown;
          try {
            rawBody = await request.json();
          } catch {
            return apiErrorResponse(
              400,
              "INVALID_REQUEST",
              "Request body must be valid JSON.",
              requestId,
            );
          }

          const parsed = ChatRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            return apiErrorResponse(
              400,
              "INVALID_REQUEST",
              "Please send a valid conversation with 1-100 messages.",
              requestId,
            );
          }

          const authContext = context as
            { userId?: string; supabase?: Parameters<typeof buildMemoryPrompt>[0] } | undefined;
          let memoryPrompt = "";
          if (authContext?.userId && authContext.supabase) {
            memoryPrompt = await buildMemoryPrompt(
              authContext.supabase,
              authContext.userId,
              getLastUserText(parsed.data.messages as unknown as UIMessage[]),
              parsed.data.context?.projectId ?? null,
            ).catch(() => "");
          }

          try {
            return streamChat(
              toChatMessages(parsed.data.messages as unknown as UIMessage[], memoryPrompt),
              parsed.data.mode ?? "balanced",
              request.signal,
            );
          } catch (error) {
            return apiErrorResponse(
              getGatewayErrorStatus(error),
              getGatewayErrorCode(error),
              getGatewayErrorMessage(error),
              requestId,
            );
          }
        },
      },
    },
  });
}

function toChatMessages(messages: UIMessage[], memoryPrompt: string): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  if (memoryPrompt) normalized.push({ role: "system", content: memoryPrompt });

  for (const message of messages) {
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
    if (content) normalized.push({ role: message.role, content });
  }
  return normalized;
}

function getGatewayErrorStatus(error: unknown): number {
  if (isAIConfigurationError(error)) return 503;
  if (isOpenRouterError(error)) {
    if (error.kind === "invalid_api_key") return 401;
    if (error.kind === "rate_limit") return 429;
    if (error.kind === "request") return 400;
  }
  return 503;
}

function getGatewayErrorCode(
  error: unknown,
):
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH_ERROR"
  | "AI_RATE_LIMITED"
  | "AI_BAD_REQUEST"
  | "AI_UPSTREAM_ERROR" {
  if (isAIConfigurationError(error)) return "AI_NOT_CONFIGURED";
  if (error instanceof OpenRouterError) {
    if (error.kind === "invalid_api_key") return "AI_AUTH_ERROR";
    if (error.kind === "rate_limit") return "AI_RATE_LIMITED";
    if (error.kind === "request") return "AI_BAD_REQUEST";
  }
  return "AI_UPSTREAM_ERROR";
}

function getGatewayErrorMessage(error: unknown): string {
  if (isAIConfigurationError(error)) return error.message;
  if (isOpenRouterError(error)) return error.message;
  return "OpenRouter is temporarily unavailable.";
}

function getLastUserText(messages: UIMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

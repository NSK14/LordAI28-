import { createFileRoute } from "@tanstack/react-router";
import type { UIMessage } from "ai";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import { streamChat } from "@/lib/ai/gateway";
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
            | { userId?: string; supabase?: Parameters<typeof buildMemoryPrompt>[0] }
            | undefined;
          let memoryPrompt = "";
          if (authContext?.userId && authContext.supabase) {
            memoryPrompt = await buildMemoryPrompt(
              authContext.supabase,
              authContext.userId,
              getLastUserText(parsed.data.messages as unknown as UIMessage[]),
              parsed.data.context?.projectId ?? null,
            ).catch(() => "");
          }

          return streamChat({
            messages: parsed.data.messages,
            modelId: parsed.data.modelId,
            mode: parsed.data.mode,
            system: memoryPrompt,
          });
        },
      },
    },
  });
}

function getLastUserText(messages: UIMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import { getSafeErrorMessage } from "@/lib/api-error";
import { generateChatTitle } from "@/lib/chat-title";

const TitleRequestSchema = z.object({ prompt: z.string().min(1).max(10000) });

export const Route = createFileRoute("/api/title")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      POST: async ({ request }) => {
        const requestId = crypto.randomUUID();
        try {
          const body = TitleRequestSchema.parse(await request.json());
          return Response.json({ title: generateChatTitle(body.prompt) ?? "New Chat" });
        } catch (error) {
          return Response.json(
            { error: { code: "INVALID_REQUEST", message: getSafeErrorMessage(error), requestId } },
            { status: 400 },
          );
        }
      },
    },
  },
});

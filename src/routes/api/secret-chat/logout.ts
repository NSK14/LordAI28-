import { createFileRoute } from "@tanstack/react-router";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import { getSecretIdentity, notFoundResponse, sessionCookie } from "@/features/secret-chat/server";

export const Route = createFileRoute("/api/secret-chat/logout")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      POST: async ({ context }) => {
        if (!getSecretIdentity(context as never)) return notFoundResponse();
        return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
      },
    },
  },
});

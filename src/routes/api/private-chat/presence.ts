import { createFileRoute } from "@tanstack/react-router";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  getSecretIdentity,
  notFoundResponse,
  resolveSecretPeer,
  verifySecretSession,
} from "@/features/secret-chat/server";

export const Route = createFileRoute("/api/private-chat/presence")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      POST: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();
        if (!verifySecretSession(request, identity.userId)) {
          return Response.json({ error: "Invalid PIN" }, { status: 403 });
        }
        try {
          await resolveSecretPeer(identity);
          return Response.json({ ok: true });
        } catch {
          return notFoundResponse();
        }
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  getSecretIdentity,
  notFoundResponse,
  resolveSecretPeer,
  verifySecretSession,
} from "@/features/secret-chat/server";

export const Route = createFileRoute("/api/secret-chat/session")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      GET: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();

        try {
          const participants = await resolveSecretPeer(identity);
          return Response.json({
            unlocked: verifySecretSession(request, identity.userId),
            userId: participants.userId,
            peerId: participants.peerId,
            peerEmail: participants.peerEmail,
            channel: "secret-chat",
          });
        } catch {
          return notFoundResponse();
        }
      },
    },
  },
});

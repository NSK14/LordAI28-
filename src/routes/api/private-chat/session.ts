import { createFileRoute } from "@tanstack/react-router";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  getSecretIdentity,
  notFoundResponse,
  resolveSecretPeer,
  verifySecretSession,
} from "@/features/secret-chat/server";

export const Route = createFileRoute("/api/private-chat/session")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      GET: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) {
          return Response.json({ authorized: false, pinVerified: false, displayLearn: false });
        }
        if (!verifySecretSession(request, identity.userId)) {
          return Response.json({ authorized: true, pinVerified: false, displayLearn: true });
        }
        try {
          const peer = await resolveSecretPeer(identity);
          return Response.json({
            authorized: true,
            pinVerified: true,
            displayLearn: true,
            userId: identity.userId,
            peerId: peer.peerId,
            peerEmail: peer.peerEmail,
          });
        } catch {
          return notFoundResponse();
        }
      },
    },
  },
});

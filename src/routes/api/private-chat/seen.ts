import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  getSecretIdentity,
  getSecretServiceClient,
  notFoundResponse,
  resolveSecretPeer,
  verifySecretSession,
} from "@/features/secret-chat/server";

const SeenSchema = z.object({ messageIds: z.array(z.string().uuid()).max(50) });

export const Route = createFileRoute("/api/private-chat/seen")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      POST: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();
        if (!verifySecretSession(request, identity.userId)) {
          return Response.json({ error: "Invalid PIN" }, { status: 403 });
        }

        const parsed = SeenSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "Invalid messages" }, { status: 400 });

        const peer = await resolveSecretPeer(identity);
        const admin = getSecretServiceClient();
        const { error } = await admin
          .from("secret_messages")
          .update({ seen_at: new Date().toISOString(), read_at: new Date().toISOString() })
          .in("id", parsed.data.messageIds)
          .eq("receiver_id", identity.userId)
          .eq("sender_id", peer.peerId)
          .is("deleted_at", null);

        if (error) return Response.json({ error: "Unable to update receipts" }, { status: 500 });
        return Response.json({ ok: true });
      },
    },
  },
});

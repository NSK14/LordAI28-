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

const MessageSchema = z.object({ message: z.string().trim().min(1).max(4000) });

export const Route = createFileRoute("/api/private-chat/messages")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      GET: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();
        if (!verifySecretSession(request, identity.userId)) {
          return Response.json({ error: "Invalid PIN" }, { status: 403 });
        }

        const peer = await resolveSecretPeer(identity);
        const admin = getSecretServiceClient();
        const { data, error } = await admin
          .from("secret_messages")
          .select("*")
          .or(
            `and(sender_id.eq.${identity.userId},receiver_id.eq.${peer.peerId}),and(sender_id.eq.${peer.peerId},receiver_id.eq.${identity.userId})`,
          )
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) return Response.json({ error: "Unable to load messages" }, { status: 500 });
        return Response.json({ messages: (data ?? []).reverse() });
      },
      POST: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();
        if (!verifySecretSession(request, identity.userId)) {
          return Response.json({ error: "Invalid PIN" }, { status: 403 });
        }

        const parsed = MessageSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: "Invalid message" }, { status: 400 });
        }

        const peer = await resolveSecretPeer(identity);
        const admin = getSecretServiceClient();
        const { data, error } = await admin
          .from("secret_messages")
          .insert({ sender_id: identity.userId, receiver_id: peer.peerId, message: parsed.data.message })
          .select()
          .single();

        if (error) return Response.json({ error: "Unable to send message" }, { status: 500 });
        return Response.json({ message: data });
      },
    },
  },
});

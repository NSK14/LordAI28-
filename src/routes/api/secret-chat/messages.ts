import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  getSecretIdentity,
  getSecretServiceClient,
  invalidSecretResponse,
  notFoundResponse,
  resolveSecretPeer,
  verifySecretSession,
} from "@/features/secret-chat/server";

const MessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

export const Route = createFileRoute("/api/secret-chat/messages")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      GET: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();
        if (!verifySecretSession(request, identity.userId)) return invalidSecretResponse();

        const peer = await resolveSecretPeer(identity);
        const admin = getSecretServiceClient();
        const { data, error } = await admin
          .from("secret_messages")
          .select("*")
          .or(
            `and(sender_id.eq.${identity.userId},receiver_id.eq.${peer.peerId}),and(sender_id.eq.${peer.peerId},receiver_id.eq.${identity.userId})`,
          )
          .order("created_at", { ascending: true });

        if (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }

        const visible = data ?? [];
        for (const row of visible) {
          if (row.receiver_id === identity.userId && !row.read_at) {
            await admin
              .from("secret_messages")
              .update({ read_at: new Date().toISOString() })
              .eq("id", row.id);
          }
        }

        return Response.json({ messages: visible });
      },
      POST: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();
        if (!verifySecretSession(request, identity.userId)) return invalidSecretResponse();

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid message payload" }, { status: 400 });
        }

        const parsed = MessageSchema.safeParse(payload);
        if (!parsed.success) {
          return Response.json({ error: parsed.error.issues[0]?.message || "Invalid message" }, { status: 400 });
        }

        const peer = await resolveSecretPeer(identity);
        const admin = getSecretServiceClient();
        const { data, error } = await admin
          .from("secret_messages")
          .insert({
            sender_id: identity.userId,
            receiver_id: peer.peerId,
            message: parsed.data.message,
          })
          .select()
          .single();

        if (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }

        return Response.json({ message: data });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  createSecretSession,
  getSecretIdentity,
  hasSecretAccess,
  invalidSecretResponse,
  isValidPin,
  notFoundResponse,
  resolveSecretPeer,
  sessionCookie,
} from "@/features/secret-chat/server";

export const Route = createFileRoute("/api/private-chat/pin")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      POST: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) {
          return hasSecretAccess(context as never)
            ? invalidSecretResponse()
            : Response.json({ error: "Access Denied" }, { status: 403 });
        }

        const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
        if (!isValidPin(body.pin)) return invalidSecretResponse();

        try {
          await resolveSecretPeer(identity);
          return Response.json(
            { ok: true },
            { headers: { "Set-Cookie": sessionCookie(createSecretSession(identity.userId)) } },
          );
        } catch {
          return invalidSecretResponse();
        }
      },
    },
  },
});

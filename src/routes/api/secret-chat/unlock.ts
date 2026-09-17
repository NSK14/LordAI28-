import { createFileRoute } from "@tanstack/react-router";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import {
  createSecretSession,
  getSecretIdentity,
  invalidSecretResponse,
  isValidPin,
  notFoundResponse,
  resolveSecretPeer,
  sessionCookie,
} from "@/features/secret-chat/server";

export const Route = createFileRoute("/api/secret-chat/unlock")({
  server: {
    middleware: [requireSupabaseRequestAuth],
    handlers: {
      POST: async ({ request, context }) => {
        const identity = getSecretIdentity(context as never);
        if (!identity) return notFoundResponse();

        let body: { pin?: unknown };
        try {
          body = (await request.json()) as { pin?: unknown };
        } catch {
          return invalidSecretResponse();
        }
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

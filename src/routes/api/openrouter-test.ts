import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/openrouter-test")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          {
            ok: false,
            error: {
              name: "ProviderUnavailable",
              message: "Provider integrations are not enabled in Phase 1.",
            },
          },
          { status: 503 },
        ),
    },
  },
});

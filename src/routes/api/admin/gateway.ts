import { createFileRoute } from "@tanstack/react-router";
import { MODEL_REGISTRY } from "@/lib/ai/models";
import { checkImageHealth } from "@/lib/ai/image";

export const Route = createFileRoute("/api/admin/gateway")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          timestamp: Date.now(),
          providerConfiguration: [],
          providers: {},
          imageProvider: await checkImageHealth(),
          registry: MODEL_REGISTRY,
        }),
      POST: async ({ request }) => {
        const action =
          (request.headers.get("content-type")?.includes("application/json")
            ? (await request.json().catch(() => ({})))?.action
            : new URL(request.url).searchParams.get("action")) ?? "reset";
        if (action === "reset" || action === "reload-env") {
          return Response.json({ ok: true, message: "No provider state is active in Phase 1" });
        }
        return Response.json({ ok: false, message: `Unknown action: ${action}` }, { status: 400 });
      },
    },
  },
});

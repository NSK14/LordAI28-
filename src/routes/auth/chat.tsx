import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/chat")({
  beforeLoad: () => {
    throw redirect({ to: "/learn", replace: true });
  },
});

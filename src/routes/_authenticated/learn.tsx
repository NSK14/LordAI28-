import { createFileRoute } from "@tanstack/react-router";
import { SecretChatPage } from "@/features/secret-chat/SecretChatPage";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/learn")({
  component: LearnSecretChat,
});

function LearnSecretChat() {
  const navigate = useNavigate();
  return <SecretChatPage onLogout={() => {
    void fetch("/api/private-chat/logout", { method: "POST", credentials: "same-origin" })
      .finally(() => navigate({ to: "/learn", replace: true }));
  }} />;
}

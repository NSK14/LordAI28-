import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "./use-current-user";

export interface PrivateChatAccess {
  authorized: boolean;
  pinVerified: boolean;
  displayLearn: boolean;
}

const PRIVATE_CHAT_ACCESS_KEY = ["private-chat-access"] as const;

async function fetchPrivateChatAccess(): Promise<PrivateChatAccess> {
  const response = await fetch("/api/private-chat/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Unable to verify access.");
  return (await response.json()) as PrivateChatAccess;
}

export function usePrivateChatAccess() {
  const queryClient = useQueryClient();
  const { user, loading: userLoading } = useCurrentUser();
  const query = useQuery({
    queryKey: PRIVATE_CHAT_ACCESS_KEY,
    queryFn: fetchPrivateChatAccess,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: !userLoading && Boolean(user),
  });

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => {
      void queryClient.resetQueries({ queryKey: PRIVATE_CHAT_ACCESS_KEY });
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient]);

  return {
    ...query,
    displayLearn: Boolean(user) && query.data?.displayLearn === true,
  };
}

export function invalidatePrivateChatAccess(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: PRIVATE_CHAT_ACCESS_KEY });
}

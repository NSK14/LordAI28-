import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildBrainContext, type BrainContextOptions } from "@/lib/brain/context";

export async function buildMemoryPrompt(
  supabase: SupabaseClient<Database>,
  userId: string,
  query: string,
  projectId?: string | null,
): Promise<string> {
  try {
    const opts: BrainContextOptions = {
      userId,
      projectId: projectId ?? null,
      query,
      maxMemories: 8,
      maxKnowledgeChunks: 3,
      maxRecentChats: 3,
      includePinnedNotes: true,
      includeRecentTasks: false,
      tokenBudget: 800,
    };
    const result = await buildBrainContext(opts);
    return result.systemPromptSnippet;
  } catch {
    return "";
  }
}

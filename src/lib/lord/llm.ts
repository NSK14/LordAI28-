import type { LordMode } from "@/lib/ai/models";

export interface LlmCallOptions {
  system: string;
  prompt: string;
  mode?: LordMode;
  maxTokens?: number;
}

export async function runLordText(
  opts: LlmCallOptions,
): Promise<{ text: string; provider?: string }> {
  void opts;
  throw new Error("OpenRouter text generation is only available through the chat gateway.");
}

export async function runLordVision(opts: {
  prompt: string;
  image: string;
  mode?: LordMode;
}): Promise<{ text: string; provider?: string }> {
  return runLordText({
    prompt: opts.prompt,
    mode: opts.mode,
    system: "Vision input is unavailable until a provider is added.",
  });
}

export async function runLordJson<T = unknown>(
  opts: LlmCallOptions & { schemaHint?: string },
): Promise<T> {
  const { text } = await runLordText(opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("The placeholder gateway did not return JSON");
  }
}

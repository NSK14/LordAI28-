import type { LordMode } from "../models";

const MODE_PROMPTS: Record<LordMode, string> = {
  fast: "Be concise. Prioritize speed and direct answers. Avoid long explanations unless requested.",
  balanced: "Give a clear, useful answer with an appropriate amount of detail.",
  coding:
    "You are a senior software engineer. Output production-quality code and explain important tradeoffs briefly.",
  creative: "Prioritize imagination, originality, and vivid but purposeful writing.",
  reasoning:
    "Think carefully before answering. Check assumptions and present the reasoning that supports the conclusion.",
  local:
    "Work efficiently as a self-contained assistant. Avoid relying on unavailable external state and be concise.",
};

export function getModePrompt(mode: LordMode): string {
  return MODE_PROMPTS[mode] ?? MODE_PROMPTS.balanced;
}

import type { AIModel, ModelInfo } from "./types";

export type LordMode = "fast" | "balanced" | "coding" | "creative" | "reasoning" | "local";

export const LORD_MODES: readonly LordMode[] = [
  "fast",
  "balanced",
  "coding",
  "creative",
  "reasoning",
  "local",
];

export const MODELS = {
  DEFAULT: "nvidia/nemotron-3-ultra-550b-a55b:free",
} as const;

export const MODEL_REGISTRY: readonly ModelInfo[] = [
  {
    id: MODELS.DEFAULT,
    label: "GPT-4.1 Mini",
    provider: "openrouter",
    supportsStreaming: true,
    supports: ["chat"],
  },
];

export const DEFAULT_MODEL_ID = MODEL_REGISTRY[0].id;

export const LORD_MODELS: Readonly<Record<LordMode, readonly string[]>> = Object.freeze({
  fast: [DEFAULT_MODEL_ID],
  balanced: [DEFAULT_MODEL_ID],
  coding: [DEFAULT_MODEL_ID],
  creative: [DEFAULT_MODEL_ID],
  reasoning: [DEFAULT_MODEL_ID],
  local: [DEFAULT_MODEL_ID],
});

export function getModel(modelId?: string): AIModel {
  return MODEL_REGISTRY[0];
}
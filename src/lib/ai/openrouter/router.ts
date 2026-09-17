import { AI } from "../config";
import type { LordMode } from "../models";
import { resolveFreeModel } from "./model-service";

export interface OpenRouterRoute {
  model: typeof AI.OPENROUTER_MODEL;
  models?: readonly [string];
  selectedModelId?: string;
}

export async function resolveOpenRouterRoute(
  mode: LordMode,
  apiKey: string,
): Promise<OpenRouterRoute> {
  const selection = await resolveFreeModel(mode, apiKey);
  return {
    model: AI.OPENROUTER_MODEL,
    models: selection.modelId ? [selection.modelId] : undefined,
    selectedModelId: selection.modelId,
  };
}

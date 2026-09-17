import { PROVIDER_CONFIG, IMAGE_MODELS } from "./lord-config";

const MODEL_COST: Record<string, { input: number; output: number }> = {};

for (const [provider, config] of Object.entries(PROVIDER_CONFIG)) {
  for (const modelId of config.models) {
    const key = modelId.includes("/") ? modelId : `${provider}/${modelId}`;
    MODEL_COST[key] = { input: 0, output: 0 };
  }
}

MODEL_COST["gemini/gemini-2.5-flash"] = { input: 0.15, output: 0.6 };
MODEL_COST["gemini/gemini-2.5-flash-lite"] = { input: 0.075, output: 0.3 };
MODEL_COST["gemini/gemini-2.0-flash"] = { input: 0.1, output: 0.4 };
MODEL_COST["openai/gpt-4o-mini"] = { input: 0.15, output: 0.6 };
MODEL_COST["openai/gpt-4o"] = { input: 2.5, output: 10.0 };

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_COST[modelId] ?? { input: 0, output: 0 };
  const cost = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  return Math.round(cost * 10000) / 10000;
}

const IMAGE_MODEL_COST: Record<string, number> = {};

for (const model of IMAGE_MODELS) {
  IMAGE_MODEL_COST[model.id] = model.estimatedPrice ?? 0;
}

export function estimateImageCost(modelId: string): number {
  return IMAGE_MODEL_COST[modelId] ?? 0;
}

import type { LordMode } from "../models";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type OpenRouterCapability =
  "fast" | "balanced" | "reasoning" | "coding" | "creative" | "local";

export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

export interface FreeModelSelection {
  requestedMode: LordMode;
  modelId?: string;
  available: boolean;
  capability: OpenRouterCapability;
}

const MODE_FALLBACK_ORDER: Record<LordMode, LordMode[]> = {
  fast: ["fast", "balanced", "reasoning"],
  balanced: ["balanced", "fast", "reasoning", "coding", "creative"],
  coding: ["coding", "balanced", "fast", "creative"],
  creative: ["creative", "balanced", "fast", "reasoning"],
  reasoning: ["reasoning", "balanced", "coding", "fast"],
  local: ["local", "balanced", "fast", "reasoning"],
};

let cache: { models: readonly OpenRouterModel[]; refreshedAt: number } | null = null;
let refreshPromise: Promise<readonly OpenRouterModel[]> | null = null;

function isFreeModel(model: OpenRouterModel): boolean {
  return (
    model.id.endsWith(":free") ||
    (model.pricing?.prompt === "0" && model.pricing?.completion === "0")
  );
}

export function getCapabilityGroup(model: OpenRouterModel): OpenRouterCapability {
  const text = `${model.id} ${model.name ?? ""}`.toLowerCase();

  if (/gpt-oss|code|coder|coding|dev|program|qwen|deepseek|claude|tool-use/.test(text))
    return "coding";
  if (/reason|think|r1|qwq|nemotron|math/.test(text)) return "reasoning";
  if (/creative|llama|gemma|mistral|phi|vision/.test(text)) return "creative";
  if (/mini|small|flash|haiku|nano|8b|7b|4b|gemma-3/.test(text)) return "fast";
  if (/balanced|base|instruct|chat/.test(text)) return "balanced";
  return "local";
}

function score(model: OpenRouterModel, mode: LordMode): number {
  const text = `${model.id} ${model.name ?? ""}`.toLowerCase();
  const context = Math.min(model.context_length ?? 0, 128_000) / 128_000;
  const capability = getCapabilityGroup(model);
  const coding = /gpt-oss|code|coder|coding|dev|program|qwen|deepseek|claude|tool-use/.test(text)
    ? 5
    : 0;
  const reasoning = /reason|think|r1|qwq|nemotron|math/.test(text) ? 5 : 0;
  const creative = /creative|llama|gemma|mistral|phi/.test(text) ? 4 : 0;
  const speed = /mini|small|flash|haiku|nano|8b|7b|4b|gemma-3/.test(text) ? 5 : 0;
  const instruction = model.supported_parameters?.includes("structured_outputs") ? 1 : 0;

  const capabilityBonus =
    capability === mode ? 10 : capability === "balanced" && mode === "fast" ? 2 : 0;

  if (mode === "fast")
    return speed + capabilityBonus + (1 - Math.max(0, context - 0.4)) + instruction;
  if (mode === "coding") return coding + context + capabilityBonus + instruction;
  if (mode === "reasoning") return reasoning + context + capabilityBonus + instruction;
  if (mode === "creative") return creative + context + capabilityBonus;
  if (mode === "local") return speed + coding + creative + capabilityBonus;
  return context + coding + reasoning + creative + instruction + capabilityBonus;
}

async function fetchModels(
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<readonly OpenRouterModel[]> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenRouter model catalog returned ${response.status}.`);
  const payload = (await response.json()) as { data?: OpenRouterModel[] };
  return (payload.data ?? []).filter(isFreeModel);
}

export async function getFreeModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly OpenRouterModel[]> {
  if (cache && Date.now() - cache.refreshedAt < CACHE_TTL_MS) return cache.models;
  if (!refreshPromise) {
    refreshPromise = fetchModels(apiKey, fetchImpl)
      .then((models) => {
        cache = { models, refreshedAt: Date.now() };
        return models;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  try {
    return await refreshPromise;
  } catch {
    return cache?.models ?? [];
  }
}

export async function resolveFreeModel(
  mode: LordMode,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FreeModelSelection> {
  const models = await getFreeModels(apiKey, fetchImpl);

  for (const fallbackMode of MODE_FALLBACK_ORDER[mode] ?? [mode]) {
    const best = [...models]
      .filter((model) => getCapabilityGroup(model) === fallbackMode || fallbackMode === "balanced")
      .sort((a, b) => score(b, fallbackMode) - score(a, fallbackMode))[0];

    if (best) {
      return {
        requestedMode: mode,
        modelId: best.id,
        available: models.length > 0,
        capability: getCapabilityGroup(best),
      };
    }
  }

  const best = [...models].sort((a, b) => score(b, mode) - score(a, mode))[0];
  return {
    requestedMode: mode,
    modelId: best?.id,
    available: models.length > 0,
    capability: best ? getCapabilityGroup(best) : "local",
  };
}

export function resetFreeModelCacheForTests(): void {
  cache = null;
  refreshPromise = null;
}

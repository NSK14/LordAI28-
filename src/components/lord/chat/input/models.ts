import { LORD_MODES, DEFAULT_MODE } from "@/lib/modes";

export interface ModelDef {
  id: string;
  label: string;
  provider: string;
}

export const MODELS: ModelDef[] = LORD_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  provider: "OpenRouter",
}));

export const DEFAULT_MODEL_ID = DEFAULT_MODE;

export function getModelDef(id: string): ModelDef {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

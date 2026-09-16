import type { ComponentType } from "react";
import { Zap, Scale, Code2, Palette, Brain, Smartphone } from "lucide-react";
import type { LordMode } from "./ai/models";

export type { LordMode } from "./ai/models";

// Client-side capability modes. The frontend only knows about these — the
// underlying model ids live on the server (see LORD_MODELS in lord-config.ts).
export interface LordModeDef {
  id: LordMode;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const LORD_MODES: LordModeDef[] = [
  { id: "fast", label: "Fast", description: "Quick answers", icon: Zap },
  { id: "balanced", label: "Balanced", description: "Best all-round", icon: Scale },
  { id: "coding", label: "Coder", description: "Code & engineering", icon: Code2 },
  { id: "creative", label: "Creator", description: "Writing & ideation", icon: Palette },
  { id: "reasoning", label: "Reasoner", description: "Deep analysis", icon: Brain },
  { id: "local", label: "Local", description: "On-device model", icon: Smartphone },
];

export const DEFAULT_MODE: LordMode = "balanced";

export function modeLabel(mode: string): string {
  return LORD_MODES.find((m) => m.id === mode)?.label ?? mode;
}

export function getModeDef(mode: string): LordModeDef | undefined {
  return LORD_MODES.find((m) => m.id === mode);
}

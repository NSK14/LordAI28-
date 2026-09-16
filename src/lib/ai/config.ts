import type { ProviderConfig } from "./types";

export interface AIConfig {
  environment: "development" | "production" | "test";
  providers: readonly ProviderConfig[];
}

function readEnvironment(): AIConfig["environment"] {
  const value = typeof process !== "undefined" ? process.env.NODE_ENV : undefined;
  if (value === "production" || value === "test") return value;
  return "development";
}

export function getAIConfig(): AIConfig {
  return {
    environment: readEnvironment(),
    providers: [],
  };
}
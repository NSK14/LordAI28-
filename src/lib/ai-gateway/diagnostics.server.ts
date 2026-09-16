import { GATEWAY_CONFIG } from "../gateway-config";
import { createLogger, type Logger } from "../gateway-logger";
import {
  ensureServerEnvLoaded,
  getProviderEnvSummaries,
  readEnvApiKey,
  summarizeSecret,
  type EnvKeySummary,
} from "../env.server";
import { PROVIDER_CONFIG, type ProviderName } from "../lord-config";

export type { ProviderName } from "../lord-config";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_CHAT_PATH = "/chat/completions";
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || "https://lordai.app";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE || "LordAI";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  gemini: "Gemini",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  cloudflare: "Cloudflare",
};

const isProd = process.env.NODE_ENV === "production";

// Read a provider key from process.env, normalized exactly as it is handed to
// the provider SDK. Reading through this one helper guarantees the SDK, the
// diagnostics, and the on-the-wire verification all observe the same value.
export function getProviderApiKey(provider: ProviderName): string | undefined {
  return readEnvApiKey(PROVIDER_CONFIG[provider].apiKeyEnv);
}

// ---------------------------------------------------------------------------
// Key validation (never logs the key itself)
// ---------------------------------------------------------------------------

export function validateApiKey(apiKey: string | undefined): { valid: boolean; issue?: string } {
  if (!apiKey) return { valid: false, issue: "missing" };
  if (apiKey !== apiKey.trim()) return { valid: false, issue: "contains surrounding whitespace" };
  if (/\s/.test(apiKey)) return { valid: false, issue: "contains whitespace" };
  if (apiKey.includes('"') || apiKey.includes("'"))
    return { valid: false, issue: "contains quotes" };
  if (apiKey.includes("\n") || apiKey.includes("\r"))
    return { valid: false, issue: "contains newline" };
  return { valid: true };
}

export function validateOpenRouterApiKey(apiKey: string | undefined): {
  valid: boolean;
  issue?: string;
} {
  return validateApiKey(apiKey);
}

function summarizeApiKey(apiKey: string | undefined) {
  return {
    exists: Boolean(apiKey),
    first8: apiKey ? apiKey.slice(0, 8) : undefined,
    length: apiKey?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Environment / local-vs-Vercel diagnostics
// ---------------------------------------------------------------------------

let diagnosticsLogged = false;

export function getLordEnvironmentDiagnostics() {
  ensureServerEnvLoaded();
  const isEdge = typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined";
  const geminiKey = getProviderApiKey("gemini");
  const openaiKey = getProviderApiKey("openai");
  const openRouterKey = getProviderApiKey("openrouter");
  return {
    hasGeminiKey: !!geminiKey,
    hasOpenRouterKey: !!openRouterKey,
    hasOpenAiKey: !!openaiKey,
    providers: {
      gemini: {
        configured: !!geminiKey && validateApiKey(geminiKey).valid,
        key: summarizeApiKey(geminiKey),
      },
      openai: {
        configured: !!openaiKey && validateApiKey(openaiKey).valid,
        key: summarizeApiKey(openaiKey),
      },
      openrouter: {
        configured: !!openRouterKey && validateApiKey(openRouterKey).valid,
        key: summarizeApiKey(openRouterKey),
      },
    },
    nodeVersion: process.version,
    runtime: isEdge ? "edge" : "node",
    platform: typeof process.platform === "string" ? process.platform : "unknown",
    deployedOn: process.env.VERCEL ? "vercel" : (process.env.NITRO_PRESET ?? "local"),
  };
}

// ---------------------------------------------------------------------------
// Startup configuration diagnostics (task 8)
// ---------------------------------------------------------------------------

export interface ProviderConfigurationDiagnostic {
  provider: ProviderName;
  label: string;
  configured: boolean;
  envVar: string;
  /** Only ever exists / first 8 characters / length — never the secret. */
  key: EnvKeySummary;
  issue?: string;
  models: readonly string[];
}

export function getProviderConfigurationDiagnostics(): ProviderConfigurationDiagnostic[] {
  ensureServerEnvLoaded();
  return (["gemini", "openai", "openrouter"] as const).map((provider) => {
    const envVar = PROVIDER_CONFIG[provider].apiKeyEnv;
    const key = getProviderApiKey(provider);
    const validation = validateApiKey(key);
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      configured: !!key && validation.valid,
      envVar,
      key: summarizeSecret(key, envVar),
      issue: key ? validation.issue : "missing",
      models: PROVIDER_CONFIG[provider].models,
    };
  });
}

/**
 * Startup diagnostics required by the runbook: for every provider print whether
 * it is configured, plus the safe key summary (exists / first 8 / length).
 */
export function logProviderConfigurationDiagnostics(
  logger?: Logger,
): ProviderConfigurationDiagnostic[] {
  const diagnostics = getProviderConfigurationDiagnostics();

  console.info("");
  console.info("==================================");
  console.info("LORD PROVIDER CONFIGURATION");
  console.info("==================================");
  for (const entry of diagnostics) {
    const state = entry.configured ? "configured" : "not configured";
    if (isProd) {
      console.info(`${entry.label}: ${state} — key exists=${entry.key.exists}`);
    } else {
      const detail = entry.key.exists
        ? `key exists=true first8=${entry.key.first8} length=${entry.key.length}`
        : `key exists=false (${entry.envVar} is not set)`;
      console.info(`${entry.label}: ${state} — ${detail}`);
    }
    if (entry.key.exists && !entry.configured) {
      console.warn(`  ⚠ ${entry.envVar} is present but unusable: ${entry.issue}`);
    }
  }
  console.info("==================================");
  console.info("");

  logger?.info("lord_provider_configuration", {
    providers: diagnostics.map((entry) => ({
      provider: entry.provider,
      configured: entry.configured,
      envVar: entry.envVar,
      key: isProd
        ? { exists: entry.key.exists }
        : { exists: entry.key.exists, first8: entry.key.first8, length: entry.key.length },
      issue: entry.issue,
    })),
    envKeys: isProd
      ? getProviderEnvSummaries().map((k) => ({ name: k.name, exists: k.exists }))
      : getProviderEnvSummaries(),
  });

  return diagnostics;
}

export function logDiagnosticsOnce() {
  if (diagnosticsLogged) return;
  diagnosticsLogged = true;
  const diag = getLordEnvironmentDiagnostics();
  if (isProd) {
    console.info(
      JSON.stringify({
        event: "lord_diagnostics",
        runtime: diag.runtime,
        deployedOn: diag.deployedOn,
        providers: Object.fromEntries(
          Object.entries(diag.providers).map(([k, v]) => [k, { configured: v.configured }]),
        ),
      }),
    );
  } else {
    console.info(JSON.stringify({ event: "lord_diagnostics", ...diag }));
  }
}

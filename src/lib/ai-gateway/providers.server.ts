import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModel } from "ai";

import { GATEWAY_CONFIG } from "../gateway-config";
import { createLogger, type Logger } from "../gateway-logger";
import { ensureServerEnvLoaded, readEnvApiKey, summarizeSecret } from "../env.server";
import { classifyModelError, OpenRouterClientError, type Candidate } from "../lord-config";
import { PROVIDER_CONFIG, type ProviderName } from "../lord-config";
import {
  logDiagnosticsOnce,
  PROVIDER_LABELS,
  validateApiKey,
  validateOpenRouterApiKey,
} from "./diagnostics.server";
import {
  mergeAbortSignals,
  classifyFetchError,
  readHeader,
  summarizePayload,
  verifyWireKey,
  makeProviderFetch,
} from "./fetch.server";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || "https://lordai.app";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE || "LordAI";

function summarizeApiKey(apiKey: string | undefined) {
  return {
    exists: Boolean(apiKey),
    first8: apiKey ? apiKey.slice(0, 8) : undefined,
    length: apiKey?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Provider parameter normalization
// ---------------------------------------------------------------------------

interface ProviderParamLimits {
  minOutputTokens: number;
  defaultTemperature: number;
  maxTemperature: number;
}

const PROVIDER_PARAM_LIMITS: Record<ProviderName, ProviderParamLimits> = {
  gemini: {
    minOutputTokens: 1,
    defaultTemperature: 0.7,
    maxTemperature: 2.0,
  },
  openrouter: {
    minOutputTokens: 1,
    defaultTemperature: 0.7,
    maxTemperature: 2.0,
  },
  openai: {
    minOutputTokens: 16,
    defaultTemperature: 0.7,
    maxTemperature: 2.0,
  },
  cloudflare: {
    minOutputTokens: 1,
    defaultTemperature: 0.7,
    maxTemperature: 2.0,
  },
};

export function normalizeProviderParams(
  provider: ProviderName,
  params: {
    maxOutputTokens?: number;
    temperature?: number;
  },
): {
  maxOutputTokens: number;
  temperature: number;
} {
  const limits = PROVIDER_PARAM_LIMITS[provider];
  const maxOutputTokens = Math.max(params.maxOutputTokens ?? 1024, limits.minOutputTokens);
  const temperature = Math.min(
    Math.max(params.temperature ?? limits.defaultTemperature, 0),
    limits.maxTemperature,
  );
  return { maxOutputTokens, temperature };
}

// ---------------------------------------------------------------------------
// Provider factories
// ---------------------------------------------------------------------------

export interface LordProviders {
  gemini: ReturnType<typeof createGoogleGenerativeAI> | null;
  openrouter: ReturnType<typeof createOpenAICompatible> | null;
  openai: ReturnType<typeof createOpenAI> | null;
  cloudflare: null;
}

export interface LordProviderMeta {
  timeoutMs: number;
  hasKey: boolean;
}

export interface LordProvidersState {
  providers: LordProviders;
  meta: Record<ProviderName, LordProviderMeta>;
}

// Lazily construct each provider only if its key is present. Missing keys are
// graceful: the provider stays `null` and candidates for it are skipped during
// routing, so LORD continues using whichever providers are configured.
//
// Keys are read through `getProviderApiKey`, which loads the env files if this
// process has not done so yet and normalizes the value (surrounding quotes and
// stray whitespace are stripped) so the SDK receives exactly the value that is
// in `process.env`.
export function createLordProviders(logger: Logger): LordProvidersState {
  ensureServerEnvLoaded();
  logDiagnosticsOnce();

  const geminiKey = readEnvApiKey("GEMINI_API_KEY");
  const openRouterKey = readEnvApiKey("OPENROUTER_API_KEY");
  const openaiKey = readEnvApiKey("OPENAI_API_KEY");

  const providers: LordProviders = {
    gemini: null,
    openrouter: null,
    openai: null,
    cloudflare: null,
  };

  const meta: Record<ProviderName, LordProviderMeta> = {
    gemini: {
      timeoutMs: GATEWAY_CONFIG.providerTimeouts.gemini,
      hasKey: !!geminiKey && validateApiKey(geminiKey).valid,
    },
    openrouter: {
      timeoutMs: GATEWAY_CONFIG.providerTimeouts.openrouter,
      hasKey: !!openRouterKey && validateApiKey(openRouterKey).valid,
    },
    openai: {
      timeoutMs: GATEWAY_CONFIG.providerTimeouts.openai,
      hasKey: !!openaiKey && validateApiKey(openaiKey).valid,
    },
    cloudflare: {
      timeoutMs: GATEWAY_CONFIG.providerTimeouts.openrouter,
      hasKey: false,
    },
  };

  if (geminiKey) {
    const validation = validateApiKey(geminiKey);
    if (!validation.valid) {
      logger.error("ai_provider_invalid_key", {
        provider: "gemini",
        envVar: "GEMINI_API_KEY",
        issue: validation.issue,
        key: summarizeApiKey(geminiKey),
      });
    } else {
      logger.info("ai_provider_sdk_configured", {
        provider: "gemini",
        source: "process.env.GEMINI_API_KEY",
        key: summarizeApiKey(geminiKey),
        sameAsProcessEnv: geminiKey === readEnvApiKey("GEMINI_API_KEY"),
      });
      providers.gemini = createGoogleGenerativeAI({
        // Read per request from process.env so a reloaded key takes effect
        // without rebuilding the provider from a stale captured value.
        apiKey: geminiKey,
        fetch: makeProviderFetch("gemini", GATEWAY_CONFIG.providerTimeouts.gemini, logger),
      });
    }
  }

  if (openRouterKey) {
    const validation = validateApiKey(openRouterKey);
    if (!validation.valid) {
      logger.error("ai_provider_invalid_key", {
        provider: "openrouter",
        envVar: "OPENROUTER_API_KEY",
        issue: validation.issue,
        key: summarizeApiKey(openRouterKey),
      });
    } else {
      logger.info("ai_provider_sdk_configured", {
        provider: "openrouter",
        source: "process.env.OPENROUTER_API_KEY",
        key: summarizeApiKey(openRouterKey),
        sameAsProcessEnv: openRouterKey === readEnvApiKey("OPENROUTER_API_KEY"),
      });
      providers.openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: OPENROUTER_BASE_URL,
        apiKey: openRouterKey,
        headers: {
          "HTTP-Referer": OPENROUTER_REFERER,
          "X-Title": OPENROUTER_TITLE,
        },
        fetch: makeProviderFetch("openrouter", GATEWAY_CONFIG.providerTimeouts.openrouter, logger),
        includeUsage: true,
      });
    }
  }

  if (openaiKey) {
    const validation = validateApiKey(openaiKey);
    if (!validation.valid) {
      logger.error("ai_provider_invalid_key", {
        provider: "openai",
        envVar: "OPENAI_API_KEY",
        issue: validation.issue,
        key: summarizeApiKey(openaiKey),
      });
    } else {
      logger.info("ai_provider_sdk_configured", {
        provider: "openai",
        source: "process.env.OPENAI_API_KEY",
        key: summarizeApiKey(openaiKey),
        sameAsProcessEnv: openaiKey === readEnvApiKey("OPENAI_API_KEY"),
      });
      providers.openai = createOpenAI({
        apiKey: openaiKey,
        fetch: makeProviderFetch("openai", GATEWAY_CONFIG.providerTimeouts.openai, logger),
      });
    }
  }

  return { providers, meta };
}

// Backwards-compatible: create a single OpenRouter provider from a key. Still
// exported for any callers/tests that relied on it; the multi-provider path
// prefers `createLordProviders` + `createLordGateway`.
export function createOpenRouterProvider(apiKey: string, logger: Logger) {
  const validation = validateApiKey(apiKey);
  if (!validation.valid) {
    logger.error("openrouter_invalid_api_key", { issue: validation.issue });
    throw new OpenRouterClientError(`Invalid OPENROUTER_API_KEY: ${validation.issue}`, {
      kind: "api",
      status: 401,
    });
  }

  logDiagnosticsOnce();

  return createOpenAICompatible({
    name: "openrouter",
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    headers: {
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": OPENROUTER_TITLE,
    },
    fetch: makeProviderFetch("openrouter", GATEWAY_CONFIG.providerTimeoutDefaultMs, logger),
    includeUsage: true,
  });
}

// Return the list of providers that have valid keys configured, in stable order.
export function getConfiguredProviders(): ProviderName[] {
  ensureServerEnvLoaded();
  return (["gemini", "openrouter", "openai"] as const).filter((p) => {
    const value = readEnvApiKey(PROVIDER_CONFIG[p].apiKeyEnv);
    return !!value && validateApiKey(value).valid;
  });
}

// Re-export types and values used by sibling modules.
export type { ProviderName } from "../lord-config";
export { OpenRouterClientError } from "../lord-config";

// Build a gateway that resolves any Candidate to the matching provider
// instance from the configured state. Throws when the candidate's provider is
// not configured (missing/invalid key) so the caller can fall back.
export type LordModelGateway = (candidate: Candidate) => LanguageModel;

export function createLordGateway(state: LordProvidersState): LordModelGateway {
  return (candidate: Candidate): LanguageModel => {
    const prov = state.providers[candidate.provider];
    if (!prov) {
      throw new OpenRouterClientError(
        `${candidate.provider} is not configured (missing or invalid API key)`,
        {
          kind: "api",
          status: 401,
          body: JSON.stringify({ provider: candidate.provider, modelId: candidate.modelId }),
        },
      );
    }
    return prov(candidate.modelId);
  };
}

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StreamTextResult,
} from "ai";

import { estimateCost } from "@/lib/model-cost";
import type { TokenUsageEvent } from "@/lib/token-usage-store";
import type { ProviderStatus } from "@/lib/api-error";
import {
  LORD_MODE_LABELS,
  LORD_MODELS,
  classifyModelError,
  isAuthFailure,
  isAuthFailureMessage,
  OpenRouterClientError,
  type LordMode,
  type ModelAttempt,
  type ProviderName,
  type Candidate,
  type ModelErrorClassification,
  PROVIDER_CONFIG,
  getModeCandidates,
  resolveCandidate,
  buildAllCandidates,
} from "./lord-config";
import { GATEWAY_CONFIG } from "./gateway-config";
import { createHealthCache, type HealthCacheEntry, type HealthCache } from "./provider-health";
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker";
import { createModelStatsStore, type ModelStatsStore } from "./model-stats";
import { createLogger, type Logger } from "./gateway-logger";
import {
  createProviderHealthManager,
  createRequestRoutingContext,
  failureKindFromClassification,
  type ProviderHealthManager,
  type RequestRoutingContext,
} from "./ai/providers";
import { OPENROUTER_DEFAULT_MODEL } from "./openrouter-provider";
import {
  ensureServerEnvLoaded,
  getProviderEnvSummaries,
  readEnvApiKey,
  summarizeSecret,
  type EnvKeySummary,
} from "./env.server";

// ---------------------------------------------------------------------------
// Re-export everything from sub-modules to preserve the existing public API
// ---------------------------------------------------------------------------

// diagnostics.server.ts
export {
  getProviderApiKey,
  validateApiKey,
  validateOpenRouterApiKey,
  getLordEnvironmentDiagnostics,
  getProviderConfigurationDiagnostics,
  logProviderConfigurationDiagnostics,
} from "./ai-gateway/diagnostics.server";
export type { ProviderConfigurationDiagnostic } from "./ai-gateway/diagnostics.server";

// fetch.server.ts
export {
  mergeAbortSignals,
  classifyFetchError,
  readHeader,
  summarizePayload,
  verifyWireKey,
  makeProviderFetch,
} from "./ai-gateway/fetch.server";

// providers.server.ts
export {
  normalizeProviderParams,
  createLordProviders,
  createOpenRouterProvider,
  getConfiguredProviders,
  createLordGateway,
} from "./ai-gateway/providers.server";
export type {
  LordProviders,
  LordProviderMeta,
  LordProvidersState,
  LordModelGateway,
} from "./ai-gateway/providers.server";

// infrastructure.server.ts
export {
  getGatewayInfrastructure,
  resetGatewayInfrastructure,
  getCachedCandidate,
  setCachedCandidate,
  invalidateCachedCandidate,
  probeBackoff,
  resetProbeCache,
} from "./ai-gateway/infrastructure.server";
export type { GatewayInfrastructure } from "./ai-gateway/infrastructure.server";

// startup.server.ts
export { validateProvidersAtStartup, logStartupBanner } from "./ai-gateway/startup.server";
export type { StartupValidationResult } from "./ai-gateway/startup.server";

// routing.server.ts
export {
  buildRoutingPlan,
  buildProviderStatuses,
  getRetryPolicy,
  candidateKey,
  AllProvidersFailedError,
} from "./ai-gateway/routing.server";

// fallback.server.ts
export {
  findFirstWorkingModel,
  streamWithFallback,
  generateTextWithFallback,
  testOpenRouterConnection,
  resetCircuitBreakers,
} from "./ai-gateway/fallback.server";
export type {
  StreamWithFallbackOptions,
  StreamWithFallbackResult,
  OpenRouterTestResult,
} from "./ai-gateway/fallback.server";

// Re-export lord-config symbols that were previously re-exported from this file
export {
  LORD_MODELS,
  LORD_SYSTEM_PROMPT,
  getLordModelCandidates,
  buildCandidates,
  getModeCandidates,
  classifyModelError,
  type LordMode,
  type ModelAttempt,
  type ProviderName,
  type Candidate,
  PROVIDER_CONFIG,
} from "./lord-config";

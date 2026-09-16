import { GATEWAY_CONFIG } from "../gateway-config";
import { createCircuitBreaker, type CircuitBreaker } from "../circuit-breaker";
import { createHealthCache, type HealthCache } from "../provider-health";
import { createLogger, type Logger } from "../gateway-logger";
import {
  createProviderHealthManager,
  createRequestRoutingContext,
  type ProviderHealthManager,
  type RequestRoutingContext,
} from "../ai/providers";
import { createModelStatsStore, type ModelStatsStore } from "../model-stats";
import { type LordProvidersState, type ProviderName } from "./providers.server";

// ---------------------------------------------------------------------------
// Gateway infrastructure (health cache, circuit breaker, model stats)
// ---------------------------------------------------------------------------

export interface GatewayInfrastructure {
  /** The single source of truth for provider health, cooldowns, and the circuit breaker. */
  providerHealth: ProviderHealthManager;
  healthCache: HealthCache;
  circuitBreaker: CircuitBreaker;
  modelStats: ModelStatsStore;
  logger: Logger;
}

let sharedInfrastructure: GatewayInfrastructure | null = null;

export function getGatewayInfrastructure(logger?: Logger): GatewayInfrastructure {
  if (!sharedInfrastructure) {
    const resolvedLogger = logger ?? createLogger(GATEWAY_CONFIG);
    sharedInfrastructure = {
      // The `ProviderHealthManager` is the authoritative gate used by routing.
      // It owns cooldowns (Phase 2), the circuit breaker (Phase 4) and the
      // in-memory skip cache (Phase 6); the legacy per-model caches below are
      // retained only for the admin dashboard's fine-grained model view.
      providerHealth: createProviderHealthManager(),
      healthCache: createHealthCache({
        defaultTtlMs: GATEWAY_CONFIG.healthCacheDefaultTtlMs,
        ttlByStatus: GATEWAY_CONFIG.healthCacheTtlByStatus,
      }),
      circuitBreaker: createCircuitBreaker({
        failureThreshold: GATEWAY_CONFIG.cbFailureThreshold,
        recoveryMs: GATEWAY_CONFIG.cbRecoveryMs,
        halfOpenSuccessThreshold: GATEWAY_CONFIG.cbHalfOpenSuccessThreshold,
      }),
      modelStats: createModelStatsStore({
        maxSamples: GATEWAY_CONFIG.modelStatsMaxSamples,
      }),
      logger: resolvedLogger,
    };
  }
  return sharedInfrastructure;
}

export function resetGatewayInfrastructure(): void {
  sharedInfrastructure = null;
}

// ---------------------------------------------------------------------------
// Model probe cache (module-level, shared across requests in the same process)
// ---------------------------------------------------------------------------
// Caches the first-working candidate per `mode` so we skip re-probing on every
// request. Positive results are cached for PROBE_CACHE_TTL_MS; a failure
// immediately invalidates the entry so we don't blindly stream to a dead model.

interface ProbeCacheEntry {
  provider: ProviderName;
  model: string;
  ts: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();

export function getCachedCandidate(mode: string): ProbeCacheEntry | null {
  const entry = probeCache.get(mode);
  if (!entry) return null;
  if (Date.now() - entry.ts > GATEWAY_CONFIG.probeCacheTtlMs) {
    probeCache.delete(mode);
    return null;
  }
  return entry;
}

export function setCachedCandidate(mode: string, entry: ProbeCacheEntry): void {
  probeCache.set(mode, entry);
}

export function invalidateCachedCandidate(mode: string): void {
  probeCache.delete(mode);
}

// Clear the entire probe cache (all modes). Exported so callers can force a
// full re-probe on config change or test reset.
export function resetProbeCache(): void {
  probeCache.clear();
}

// Exponential backoff retry for transient probe/stream errors. Returns the
// delay (ms) before the next retry attempt, or 0 if no more retries remain.
export function probeBackoff(attempt: number, maxAttempts: number): number {
  if (attempt >= maxAttempts) return 0;
  return Math.min(
    GATEWAY_CONFIG.retryBackoffBaseMs * GATEWAY_CONFIG.retryBackoffMultiplier ** attempt,
    GATEWAY_CONFIG.retryBackoffMaxMs,
  );
}

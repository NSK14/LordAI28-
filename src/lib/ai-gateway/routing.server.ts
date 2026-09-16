import { GATEWAY_CONFIG } from "../gateway-config";
import { type ProviderStatus } from "../api-error";
import { classifyModelError, PROVIDER_CONFIG } from "../lord-config";
import {
  failureKindFromClassification,
  createRequestRoutingContext,
  type RequestRoutingContext,
} from "../ai/providers";
import {
  getGatewayInfrastructure,
  type GatewayInfrastructure,
  getCachedCandidate,
  setCachedCandidate,
  invalidateCachedCandidate,
  probeBackoff,
} from "./infrastructure.server";
import { type LordProvidersState, type ProviderName } from "./providers.server";
import { PROVIDER_LABELS } from "./diagnostics.server";
import {
  getModeCandidates,
  resolveCandidate,
  type Candidate,
  type ModelAttempt,
  type ModelErrorClassification,
  type LordMode,
} from "../lord-config";
import { OpenRouterClientError } from "../lord-config";
import { generateText } from "ai";

export function candidateKey(candidate: Candidate): string {
  return `${candidate.provider}:${candidate.modelId}`;
}

/**
 * Error thrown when routing is exhausted. It carries which providers were
 * actually contacted so the caller can only report "All configured models
 * failed" when every configured provider really was attempted.
 */
export class AllProvidersFailedError extends Error {
  readonly lordAttempts: ModelAttempt[];
  readonly configuredProviders: ProviderName[];
  readonly attemptedProviders: ProviderName[];
  readonly notAttemptedProviders: ProviderName[];
  readonly allProvidersAttempted: boolean;
  readonly providerStatuses: ProviderStatus[];

  constructor(
    message: string,
    info: {
      attempts: ModelAttempt[];
      configuredProviders: ProviderName[];
      attemptedProviders: ProviderName[];
      providerStatuses: ProviderStatus[];
    },
  ) {
    super(message);
    this.name = "AllProvidersFailedError";
    this.lordAttempts = info.attempts;
    this.configuredProviders = info.configuredProviders;
    this.attemptedProviders = info.attemptedProviders;
    this.notAttemptedProviders = info.configuredProviders.filter(
      (p) => !info.attemptedProviders.includes(p),
    );
    this.allProvidersAttempted = this.notAttemptedProviders.length === 0;
    this.providerStatuses = info.providerStatuses;
  }
}

// Build the ordered routing plan for a request.
//
// The mode's own candidate order is preserved (and still sorted by dynamic
// routing stats) so normal routing behaviour is unchanged. Two guarantees are
// added on top:
//   1. every configured provider is represented, by appending its remaining
//      models after the mode list — a provider is never skipped just because
//      the single model it contributes to this mode is unavailable;
//   2. a candidate is REMOVED (not merely deferred) whenever its provider is in
//      cooldown, has an open circuit, is unconfigured, or has already failed in
//      this request. This is what makes "a provider is never retried after a
//      429 within the same request" a hard guarantee — a 429 puts the provider
//      into cooldown at the single source of truth (ProviderHealthManager), so
//      it cannot appear again in this request's plan.
export function buildRoutingPlan(
  opts: {
    mode: LordMode;
    state: LordProvidersState;
    explicitModelId?: string;
  },
  infra: GatewayInfrastructure,
  context: RequestRoutingContext,
): { plan: Candidate[]; deferred: Set<string>; configuredProviders: ProviderName[] } {
  const { mode, state } = opts;

  const resolvedExplicit = opts.explicitModelId ? resolveCandidate(opts.explicitModelId) : null;
  const hasKey = (provider: ProviderName) => !!state.meta[provider]?.hasKey;

  // Keep the health manager aligned with the provider instances created for
  // this request. A fresh manager starts providers as unconfigured, while the
  // provider state is the authoritative result of environment validation.
  for (const provider of ["gemini", "openrouter", "openai"] as const) {
    infra.providerHealth.setConfigured(provider, hasKey(provider));
  }

  const modeCandidates = getModeCandidates(
    mode,
    resolvedExplicit ? undefined : opts.explicitModelId,
    resolvedExplicit?.provider,
    resolvedExplicit?.modelId,
  ).filter((c) => hasKey(c.provider));

  // Dynamic routing: sort the mode's candidates by the health manager's view
  // (lowest latency -> highest success rate -> fewest recent failures). This is
  // a pure ranking over cached health, so it adds no network calls.
  if (GATEWAY_CONFIG.dynamicRoutingEnabled && !opts.explicitModelId) {
    modeCandidates.sort((a, b) => {
      const ra = infra.providerHealth.get(a.provider);
      const rb = infra.providerHealth.get(b.provider);
      const latA = infra.providerHealth.effectiveLatencyMs(a.provider);
      const latB = infra.providerHealth.effectiveLatencyMs(b.provider);
      const failA = ra.failureCount;
      const failB = rb.failureCount;
      const rateA = ra.successRate;
      const rateB = rb.successRate;
      if (failA !== failB) return failA - failB;
      if (rateA !== rateB) return rateB - rateA;
      return latA - latB;
    });
  }

  const configuredProviders = (["gemini", "openrouter", "openai"] as const).filter(hasKey);

  const seen = new Set(modeCandidates.map(candidateKey));
  const providerCompletion: Candidate[] = [];
  for (const provider of configuredProviders) {
    for (const modelId of PROVIDER_CONFIG[provider].models) {
      const candidate: Candidate = { provider, modelId };
      if (seen.has(candidateKey(candidate))) continue;
      seen.add(candidateKey(candidate));
      providerCompletion.push(candidate);
    }
  }

  const ordered = [...modeCandidates, ...providerCompletion];
  const usable: Candidate[] = [];
  const deferredCandidates: Candidate[] = [];
  const deferred = new Set<string>();

  for (const candidate of ordered) {
    const provider = candidate.provider;
    // `state.meta[provider].hasKey` is the authority for "is this provider
    // usable right now" (set by `createLordProviders` from the real env). Only
    // providers with a key are eligible; everything else is dropped outright.
    if (!state.meta[provider]?.hasKey) continue;

    // Per-request guarantee: never retry a provider that already failed here.
    const requestSkip = context.getSkip(provider);
    if (requestSkip) {
      continue;
    }
    // Single source of truth: the health manager owns cooldown + circuit state.
    // A cooldown-capable failure (e.g. 429) disables the provider for the rest
    // of this request, so it cannot be re-tried within the same request. A
    // cooldown triggered *by this request* is ignored here (the per-request
    // context already blocks the re-try); cross-request cooldowns still block.
    const managerSkip = infra.providerHealth.getSkip(provider, {
      requestStartedAt: context.requestStartedAt,
    });
    if (managerSkip && managerSkip.code !== "not_configured") continue;
    // Legacy per-model guards, kept for the admin view's granularity.
    if (infra.circuitBreaker.isOpen(provider, candidate.modelId)) {
      deferred.add(candidateKey(candidate));
      deferredCandidates.push(candidate);
      continue;
    }
    if (!infra.healthCache.isHealthy(provider, candidate.modelId)) {
      deferred.add(candidateKey(candidate));
      deferredCandidates.push(candidate);
      continue;
    }
    usable.push(candidate);
  }

  // A stale model-level health entry is a soft signal, not permission to
  // report that fallback never ran. Try healthy candidates first, then make a
  // last-resort attempt against deferred models. Provider cooldowns and
  // per-request failures remain hard exclusions above.
  return { plan: [...usable, ...deferredCandidates], deferred, configuredProviders };
}

export function buildProviderStatuses(
  configuredProviders: ProviderName[],
  attempts: Map<ProviderName, ModelAttempt[]>,
): ProviderStatus[] {
  return configuredProviders.map((provider) => {
    const providerAttempts = attempts.get(provider) ?? [];
    const label = PROVIDER_LABELS[provider];
    if (providerAttempts.length === 0) {
      return { provider: label, status: "unavailable" as const };
    }
    const last = providerAttempts[providerAttempts.length - 1];
    if (last.reason === GATEWAY_CONFIG.errorReasonLabels.invalid_api_key) {
      return { provider: label, status: "invalid" as const };
    }
    if (last.reason === GATEWAY_CONFIG.errorReasonLabels.missing_api_key) {
      return { provider: label, status: "missing_api_key" as const };
    }
    if (last.reason === GATEWAY_CONFIG.errorReasonLabels.rate_limit) {
      return { provider: label, status: "rate_limited" as const };
    }
    return { provider: label, status: "unavailable" as const };
  });
}

// Get the retry policy for a given error classification.
export function getRetryPolicy(classification: ModelErrorClassification) {
  const statusKey =
    classification.status !== undefined ? String(classification.status) : classification.reason;
  return (
    GATEWAY_CONFIG.retryPolicy[statusKey] ?? {
      retryable: classification.retryable,
      maxRetries: classification.retryable ? GATEWAY_CONFIG.maxRetriesDefault : 0,
    }
  );
}

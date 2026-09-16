import { generateText, streamText, type LanguageModel, type ModelMessage } from "ai";

import { estimateCost } from "../model-cost";
import type { TokenUsageEvent } from "../token-usage-store";
import {
  classifyModelError,
  isAuthFailure,
  OpenRouterClientError,
  LORD_MODE_LABELS,
  type LordMode,
  type ModelAttempt,
  type ProviderName,
  type Candidate,
  type ModelErrorClassification,
} from "../lord-config";
import { GATEWAY_CONFIG } from "../gateway-config";
import { createLogger, type Logger } from "../gateway-logger";
import {
  createProviderHealthManager,
  createRequestRoutingContext,
  failureKindFromClassification,
  type ProviderHealthManager,
  type RequestRoutingContext,
} from "../ai/providers";
import {
  getGatewayInfrastructure,
  type GatewayInfrastructure,
  getCachedCandidate,
  setCachedCandidate,
  invalidateCachedCandidate,
  probeBackoff,
  resetProbeCache,
  resetGatewayInfrastructure,
} from "./infrastructure.server";
import { type LordProvidersState } from "./providers.server";
import {
  getLordEnvironmentDiagnostics,
  logDiagnosticsOnce,
  PROVIDER_LABELS,
} from "./diagnostics.server";
import { normalizeProviderParams, type LordModelGateway } from "./providers.server";
import {
  buildRoutingPlan,
  buildProviderStatuses,
  getRetryPolicy,
  candidateKey,
  AllProvidersFailedError,
} from "./routing.server";
import { OPENROUTER_DEFAULT_MODEL } from "../openrouter-provider";

export interface StreamWithFallbackOptions {
  gateway: LordModelGateway;
  state: LordProvidersState;
  mode: LordMode;
  explicitModelId?: string;
  system: string;
  messages: ModelMessage[];
  requestId: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onTokenUsage?: (event: TokenUsageEvent) => void;
}

export interface StreamWithFallbackResult {
  result: Awaited<ReturnType<typeof streamText>>;
  model: string;
  provider: ProviderName;
  attempts: ModelAttempt[];
  /** Milliseconds from streamText call until first chunk arrives (TTFT). */
  ttftMs: number;
  /** Milliseconds from first chunk until stream end. */
  streamMs: number;
}

function logGateway(logger: Logger, event: string, payload: Record<string, unknown>) {
  logger.info(event, payload);
}

// Tries each candidate model for `mode` in order. A candidate is validated with
// a cheap pre-flight call; on failure its error is classified:
//   - retryable  -> log and move to the next candidate
//   - non-retryable -> skip the model and move to the next candidate
//   - authentication failure -> disable that provider for the rest of this
//     request (its remaining models cannot succeed with a rejected key) and
//     continue with the next provider
// The first candidate that passes the probe is returned so the caller can
// either stream it or complete it. Throws `AllProvidersFailedError` only after
// every configured provider has actually been attempted.
export async function findFirstWorkingModel(opts: StreamWithFallbackOptions): Promise<{
  candidate: Candidate;
  provider: ProviderName;
  attempts: ModelAttempt[];
  probeMs: number;
}> {
  const { mode, requestId, state } = opts;
  const infra = getGatewayInfrastructure();
  const logger = infra.logger;
  // Per-request context: the hard guarantee that a provider which fails in this
  // request is never contacted again for the remainder of it (Phase 3).
  const routingContext = createRequestRoutingContext(requestId);
  const { plan, deferred, configuredProviders } = buildRoutingPlan(opts, infra, routingContext);
  const candidates = plan;

  const modeLabel = LORD_MODE_LABELS[mode];
  const probeStart = performance.now();

  // Fast-path: if we have a fresh cache hit for this mode and its provider is
  // still healthy + configured + not in cooldown, use it directly (unless an
  // explicit modelId was requested, in which case we must probe it).
  const cached = opts.explicitModelId ? null : getCachedCandidate(mode);
  if (cached && !opts.explicitModelId) {
    const stillConfigured =
      state.meta[cached.provider]?.hasKey &&
      infra.providerHealth.isAvailable(cached.provider) &&
      routingContext.getSkip(cached.provider) === null;
    if (stillConfigured) {
      logGateway(logger, "ai_probe_cache_hit", {
        requestId,
        mode,
        provider: cached.provider,
        model: cached.model,
      });
      return {
        candidate: { provider: cached.provider, modelId: cached.model },
        provider: cached.provider,
        attempts: [],
        probeMs: 0,
      };
    }
    invalidateCachedCandidate(mode);
  }

  logger.info("ai_mode", { mode: modeLabel });

  const attempts: ModelAttempt[] = [];
  const attemptsByProvider = new Map<ProviderName, ModelAttempt[]>();
  const attemptedProviders: ProviderName[] = [];
  // Providers whose credentials were rejected during THIS request. Their
  // remaining models cannot succeed with a rejected key, so they are skipped
  // immediately and routing continues with the next provider.
  const authDisabledProviders = new Set<ProviderName>();

  const recordAttempt = (provider: ProviderName, attempt: ModelAttempt) => {
    attempts.push(attempt);
    const list = attemptsByProvider.get(provider) ?? [];
    list.push(attempt);
    attemptsByProvider.set(provider, list);
  };
  const markAttempted = (provider: ProviderName) => {
    if (!attemptedProviders.includes(provider)) attemptedProviders.push(provider);
  };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const { provider, modelId } = candidate;
    const attemptNum = i + 1;

    // The plan is built once, but provider failures are discovered while it is
    // being consumed. Re-check the request context here so a provider-scoped
    // failure (429, auth, timeout, network, or 5xx) removes all of its later
    // candidates from this request immediately.
    if (routingContext.getSkip(provider)) {
      continue;
    }

    // Provider already failed authentication in this request: skip the rest of
    // its models straight away (task 5 / task 6) and continue with the next
    // provider instead of burning another round trip on a rejected key.
    if (authDisabledProviders.has(provider)) {
      logger.info("ai_provider_skipped_auth_disabled", {
        requestId,
        mode,
        provider,
        model: modelId,
        reason: "Provider disabled for this request after an authentication failure",
      });
      continue;
    }

    logger.info("Attempt " + attemptNum + ":\n" + provider + ":" + modelId, {
      requestId,
      mode,
      attempt: attemptNum,
      provider,
      model: modelId,
    });
    logGateway(logger, "ai_provider_selected", {
      requestId,
      mode,
      attempt: attemptNum,
      provider,
      model: modelId,
      // Deferred candidates are the ones a health/circuit check had previously
      // parked; they are still attempted so no provider is silently skipped.
      deferred: deferred.has(candidateKey(candidate)),
    });

    // Skip candidates whose provider has no valid key configured.
    if (!state.meta[provider]?.hasKey) {
      recordAttempt(provider, {
        provider,
        model: modelId,
        status: 0,
        reason: GATEWAY_CONFIG.errorReasonLabels.missing_api_key,
        retryable: false,
        providerMessage: `Provider "${provider}" has no valid API key`,
        timestamp: Date.now(),
      });
      continue;
    }

    markAttempted(provider);
    routingContext.markAttempt(provider, modelId);

    // Exponential retry for transient probe failures: a provider may be
    // flapping, so we retry a couple of times before giving up on it.
    const maxProbeAttempts = GATEWAY_CONFIG.probeMaxAttempts;
    let probed = false;
    for (let probeTry = 0; probeTry < maxProbeAttempts && !probed; probeTry++) {
      try {
        await generateText({
          model: opts.gateway(candidate),
          system: "Reply with OK",
          messages: [{ role: "user", content: "OK" }],
          maxOutputTokens:
            GATEWAY_CONFIG.probeMaxOutputTokensByProvider[provider] ??
            GATEWAY_CONFIG.probeMaxOutputTokens,
          temperature: 0,
          maxRetries: 0,
          timeout: GATEWAY_CONFIG.probeTimeoutMs,
          abortSignal: opts.abortSignal,
        });
        probed = true;
      } catch (err) {
        const classification = classifyModelError(err);
        const errProvider: ProviderName =
          err instanceof OpenRouterClientError
            ? (((err as unknown as { lordProvider?: string }).lordProvider ??
                provider) as ProviderName)
            : provider;
        const attempt: ModelAttempt = {
          provider,
          model: modelId,
          status: classification.status ?? 0,
          reason: GATEWAY_CONFIG.errorReasonLabels[classification.reason] ?? classification.reason,
          retryable: classification.retryable,
          providerMessage: classification.providerMessage,
          errorCode: classification.errorCode,
          requestId: classification.requestId,
          timestamp: Date.now(),
        };
        recordAttempt(provider, attempt);
        logger.info(
          "Failed:\n" +
            attempt.reason +
            " (status: " +
            attempt.status +
            ", retryable: " +
            attempt.retryable +
            ")",
          {
            requestId,
            provider,
            model: modelId,
            reason: attempt.reason,
            status: attempt.status,
            retryable: attempt.retryable,
          },
        );

        // Record circuit-breaker / health state for the failing provider/model.
        infra.circuitBreaker.recordFailure(errProvider, modelId);
        infra.healthCache.set({
          provider: errProvider,
          model: modelId,
          status: classification.retryable ? "unavailable" : "invalid",
          reason: attempt.reason,
          timestamp: Date.now(),
          expiresAt:
            Date.now() + infra.healthCache.getTtlForStatus(classification.status ?? "unknown"),
          httpStatus: classification.status,
          retryable: classification.retryable,
        });
        infra.modelStats.record(errProvider, modelId, {
          success: false,
          ttftMs: 0,
          streamMs: 0,
          reason: attempt.reason,
        });

        // Record the failure at the single source of truth. A cooldown-capable
        // failure (e.g. 429) immediately disables this provider for the rest of
        // this request via `buildRoutingPlan`, so it is never re-tried here.
        const failureKind = failureKindFromClassification(classification);
        infra.providerHealth.recordFailure(errProvider, {
          kind: failureKind,
          status: classification.status,
          message: classification.providerMessage ?? attempt.reason,
          model: errProvider === provider ? modelId : undefined,
          latencyMs: 0,
        });
        routingContext.recordFailure({
          provider: errProvider,
          kind: failureKind,
          status: classification.status,
          model: errProvider === provider ? modelId : undefined,
          message: classification.providerMessage ?? attempt.reason,
        });

        // Authentication failure (401/403, or Gemini's 400 API_KEY_INVALID):
        // the key itself was rejected, so every other model of this provider
        // would fail the same way. Disable the provider for the remainder of
        // this request and continue with the next configured provider.
        if (isAuthFailure(classification)) {
          authDisabledProviders.add(errProvider);
          logger.error("ai_provider_auth_disabled", {
            requestId,
            mode,
            provider: errProvider,
            envVar: PROVIDER_LABELS[errProvider],
            status: classification.status,
            reason: attempt.reason,
            providerMessage: classification.providerMessage,
            message: `${PROVIDER_LABELS[errProvider]} authentication failed — disabled for this request, continuing with the remaining providers.`,
          });
          break;
        }

        if (!classification.retryable) {
          // Non-retryable (e.g. unsupported request) for THIS model — move on
          // to the next candidate rather than aborting the whole request.
          logger.warn("Skipping invalid model " + modelId + ": " + classification.providerMessage, {
            requestId,
            provider,
            model: modelId,
          });
          break;
        }

        // Retryable: check retry policy and back off briefly if retries remain.
        const policy = getRetryPolicy(classification);
        if (probeTry < policy.maxRetries - 1) {
          const delay = probeBackoff(probeTry, maxProbeAttempts);
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }
        // No retries left: fall through to the next candidate.
        break;
      }
    }

    if (probed) {
      // Success: cache this candidate as the preferred choice for this mode.
      setCachedCandidate(mode, { provider, model: modelId, ts: Date.now() });
      infra.circuitBreaker.recordSuccess(provider, modelId);
      infra.providerHealth.recordSuccess(provider, { model: modelId });
      infra.healthCache.set({
        provider,
        model: modelId,
        status: "healthy",
        reason: "",
        timestamp: Date.now(),
        expiresAt: Date.now() + GATEWAY_CONFIG.healthCacheDefaultTtlMs,
      });
      infra.modelStats.record(provider, modelId, {
        success: true,
        ttftMs: 0,
        streamMs: 0,
      });
      logger.info("Success", {
        requestId,
        mode,
        provider,
        model: modelId,
      });
      const probeMs = Math.round(performance.now() - probeStart);
      logGateway(logger, "ai_probe_complete", {
        requestId,
        mode,
        provider,
        model: modelId,
        probeMs,
        attempts: attempts.length,
      });
      return { candidate, provider, attempts, probeMs };
    }
  }

  // All probes failed: invalidate any stale cache entry for this mode so the
  // next request starts fresh instead of blindly streaming to a dead model.
  invalidateCachedCandidate(mode);
  const probeMs = Math.round(performance.now() - probeStart);
  const notAttemptedProviders = configuredProviders.filter((p) => !attemptedProviders.includes(p));
  const providerStatuses = buildProviderStatuses(configuredProviders, attemptsByProvider);

  logger.error("lord_mode_exhausted", {
    requestId,
    mode,
    configuredProviders,
    attemptedProviders,
    notAttemptedProviders,
    authDisabledProviders: [...authDisabledProviders],
    allProvidersAttempted: notAttemptedProviders.length === 0,
    providerStatuses,
    attempts,
    probeMs,
  });

  // The message distinguishes a genuine exhaustion (every configured provider
  // was contacted) from an early exit — the caller must not report
  // "All configured models failed" unless the former is true.
  const message =
    notAttemptedProviders.length === 0
      ? `All configured providers failed for mode "${mode}" (attempted: ${attemptedProviders.join(", ") || "none"}).`
      : `Routing for mode "${mode}" ended before every configured provider was attempted (attempted: ${attemptedProviders.join(", ") || "none"}; not attempted: ${notAttemptedProviders.join(", ")}).`;

  throw new AllProvidersFailedError(message, {
    attempts,
    configuredProviders,
    attemptedProviders,
    providerStatuses,
  });
}

export async function streamWithFallback(
  opts: StreamWithFallbackOptions,
): Promise<StreamWithFallbackResult> {
  const { mode, requestId, state } = opts;
  const infra = getGatewayInfrastructure();
  const logger = infra.logger;
  const { candidate, provider, attempts, probeMs } = await findFirstWorkingModel(opts);
  const modelId = candidate.modelId;

  let firstChunkLogged = false;
  let tokensEmitted = 0;
  const streamStart = performance.now();
  let firstChunkTime = 0;
  let streamEndTime = 0;
  let streamError: Error | null = null;

  const providerTimeout =
    state.meta[provider]?.timeoutMs ?? GATEWAY_CONFIG.providerTimeoutDefaultMs;

  const normalizedParams = normalizeProviderParams(provider, {
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  });

  const result = streamText({
    model: opts.gateway(candidate),
    system: opts.system,
    messages: opts.messages,
    maxOutputTokens: normalizedParams.maxOutputTokens,
    temperature: normalizedParams.temperature,
    maxRetries: GATEWAY_CONFIG.maxRetriesDefault,
    timeout: opts.timeoutMs ?? providerTimeout,
    abortSignal: opts.abortSignal,
    experimental_onStart: () => {
      logGateway(logger, "ai_stream_start", {
        requestId,
        mode,
        provider,
        model: modelId,
        probeMs,
      });
    },
    onChunk: ({ chunk }) => {
      if (!firstChunkLogged && chunk.type === "text-delta") {
        firstChunkLogged = true;
        firstChunkTime = performance.now();
        const ttft = Math.round(firstChunkTime - streamStart);
        logGateway(logger, "ai_stream_first_chunk", {
          requestId,
          mode,
          provider,
          model: modelId,
          ttftMs: ttft,
          probeMs,
        });
      }
      if (chunk.type === "text-delta") {
        tokensEmitted += 1;
      }
    },
    onError: ({ error }) => {
      const errProvider: ProviderName =
        error instanceof OpenRouterClientError
          ? (((error as unknown as { lordProvider?: string }).lordProvider ??
              provider) as ProviderName)
          : provider;
      infra.circuitBreaker.recordFailure(errProvider, modelId);
      const classification = classifyModelError(error);
      infra.providerHealth.recordFailure(errProvider, {
        kind: failureKindFromClassification(classification),
        status: classification.status,
        message: classification.providerMessage,
        model: modelId,
      });
      infra.healthCache.set({
        provider: errProvider,
        model: modelId,
        status: classification.retryable ? "unavailable" : "invalid",
        reason: GATEWAY_CONFIG.errorReasonLabels[classification.reason] ?? classification.reason,
        timestamp: Date.now(),
        expiresAt:
          Date.now() + infra.healthCache.getTtlForStatus(classification.status ?? "unknown"),
        httpStatus: classification.status,
        retryable: classification.retryable,
      });
      infra.modelStats.record(errProvider, modelId, {
        success: false,
        ttftMs: firstChunkTime > 0 ? Math.round(firstChunkTime - streamStart) : 0,
        streamMs: 0,
        reason: GATEWAY_CONFIG.errorReasonLabels[classification.reason] ?? classification.reason,
      });
      logger.error("ai_stream_error", {
        requestId,
        mode,
        provider,
        model: modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      streamError = error instanceof Error ? error : new Error(String(error));
    },
    onFinish: ({ finishReason, usage }) => {
      streamEndTime = performance.now();
      const ttftMs = firstChunkTime > 0 ? Math.round(firstChunkTime - streamStart) : 0;
      const streamMs = firstChunkTime > 0 ? Math.round(streamEndTime - firstChunkTime) : 0;
      const cost = estimateCost(modelId, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
      infra.circuitBreaker.recordSuccess(provider, modelId);
      infra.providerHealth.recordSuccess(provider, { model: modelId });
      infra.healthCache.set({
        provider,
        model: modelId,
        status: "healthy",
        reason: "",
        timestamp: Date.now(),
        expiresAt: Date.now() + GATEWAY_CONFIG.healthCacheDefaultTtlMs,
      });
      infra.modelStats.record(provider, modelId, {
        success: true,
        ttftMs,
        streamMs,
      });
      logGateway(logger, "ai_stream_end", {
        requestId,
        mode,
        provider,
        model: modelId,
        finishReason,
        probeMs,
        ttftMs,
        streamMs,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
          cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cost,
        },
      });
      opts.onTokenUsage?.({
        requestId,
        model: modelId,
        mode,
        finishReason,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        cost,
        timestamp: Date.now(),
      });
    },
  });

  const ttftMs = firstChunkTime > 0 ? Math.round(firstChunkTime - streamStart) : 0;
  const finalStreamMs =
    firstChunkTime > 0 ? Math.round((streamEndTime || performance.now()) - firstChunkTime) : 0;

  // If the stream errored before emitting any tokens, treat as a failed probe
  // so the caller can retry with another provider.
  if (streamError && tokensEmitted === 0 && GATEWAY_CONFIG.streamingRetryIfNoTokens) {
    infra.circuitBreaker.recordFailure(provider, modelId);
    infra.healthCache.set({
      provider,
      model: modelId,
      status: "unavailable",
      reason: "Stream interrupted before first token",
      timestamp: Date.now(),
      expiresAt: Date.now() + GATEWAY_CONFIG.healthCacheTtlByStatus.timeout,
      retryable: true,
    });
    throw streamError;
  }

  // If the stream errored after emitting tokens, do NOT silently retry —
  // surface the partial result with the error so the caller can decide.
  if (streamError && tokensEmitted > 0) {
    logger.warn("ai_stream_partial_error", {
      requestId,
      mode,
      provider,
      model: modelId,
      tokensEmitted,
      error: String(streamError),
    });
  }

  return { result, model: modelId, provider, attempts, ttftMs, streamMs: finalStreamMs };
}

// Non-streaming variant used for diagnostics: verifies normal completions work
// before relying on streaming.
export async function generateTextWithFallback(opts: StreamWithFallbackOptions): Promise<{
  text: string;
  candidate: Candidate;
  provider: ProviderName;
  attempts: ModelAttempt[];
}> {
  const { candidate, provider, attempts } = await findFirstWorkingModel(opts);
  const modelId = candidate.modelId;
  const providerTimeout =
    opts.state.meta[provider]?.timeoutMs ?? GATEWAY_CONFIG.providerTimeoutDefaultMs;
  const normalizedParams = normalizeProviderParams(provider, {
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  });
  const { text } = await generateText({
    model: opts.gateway(candidate),
    system: opts.system,
    messages: opts.messages,
    maxOutputTokens: normalizedParams.maxOutputTokens,
    temperature: normalizedParams.temperature,
    maxRetries: GATEWAY_CONFIG.maxRetriesDefault,
    timeout: opts.timeoutMs ?? providerTimeout,
    abortSignal: opts.abortSignal,
  });
  return { text, candidate, provider, attempts };
}

// ---------------------------------------------------------------------------
// Standalone raw connection test (task 9). Uses the global fetch directly so
// the result is isolated from the AI-SDK chat pipeline. If this fails, the
// problem is outside the chat system (key, network, or OpenRouter itself).
// ---------------------------------------------------------------------------

export interface OpenRouterTestResult {
  ok: boolean;
  url: string;
  model: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  rawText?: string;
  json?: unknown;
  error?: { name: string; message: string; stack?: string };
  diagnostics: ReturnType<typeof getLordEnvironmentDiagnostics>;
}

export async function testOpenRouterConnection(opts: {
  apiKey: string;
  model?: string;
  prompt?: string;
}): Promise<OpenRouterTestResult> {
  const model = opts.model ?? OPENROUTER_DEFAULT_MODEL;
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const body = {
    model,
    stream: false,
    messages: [{ role: "user", content: opts.prompt ?? "Say hello." }],
    max_tokens: 512,
    temperature: 0,
  };
  const diagnostics = getLordEnvironmentDiagnostics();
  const logger = getGatewayInfrastructure().logger;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_CONFIG.providerTimeoutDefaultMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://lordai.app",
        "X-Title": process.env.OPENROUTER_TITLE || "LordAI",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await res.text();
    const responseHeaders: Record<string, string> = {};
    if (typeof res.headers?.entries === "function") {
      for (const [k, v] of res.headers.entries()) responseHeaders[k] = v;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = undefined;
    }

    return {
      ok: res.ok,
      url,
      model,
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      rawText,
      json,
      diagnostics,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("openrouter_test_failed", {
      model,
      error: message,
    });
    return {
      ok: false,
      url,
      model,
      error: { name, message, stack },
      diagnostics,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Clear all circuit-breaker, health-cache and probe-cache state. Intended for
// tests and hot-reload safety so a previous process' failure counts and
// preferred models are not inherited.
export function resetCircuitBreakers(): void {
  const infra = getGatewayInfrastructure();
  infra.circuitBreaker.resetAll();
  infra.healthCache.clear();
  // The `ProviderHealthManager` is the authoritative cooldown/circuit source:
  // reset it so a previous process' state is never inherited (tests, hot reload).
  infra.providerHealth.reset();
  resetProbeCache();
  resetGatewayInfrastructure();
}

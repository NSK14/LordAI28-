import { describe, expect, it, vi } from "vitest";
import {
  compareProviderRanking,
  rankProviders,
  selectEligibleProviders,
  createRequestRoutingContext,
  LATENCY_BUCKET_MS,
} from "./provider-router";
import type {
  ProviderFailure,
  ProviderHealth,
  ProviderHealthManager,
  ProviderSkip,
} from "./provider-health-manager";
import type { ProviderId, ProviderFailureKind, ProviderLabel } from "./provider-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tick: number;

function makeHealth(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  tick ??= 1_000_000_000_000;
  return {
    provider: "Gemini",
    status: "healthy",
    lastSuccess: null,
    lastFailure: null,
    failureCount: 0,
    averageLatencyMs: 100,
    providerId: "gemini" as ProviderId,
    configured: true,
    configurationIssue: null,
    circuitState: "closed",
    disabledUntilConfigChange: false,
    consecutiveSuccesses: 0,
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    requestsToday: 0,
    successRate: 1,
    cooldownRemainingMs: 0,
    cooldownReason: null,
    lastFailureKind: null,
    lastFailureStatus: null,
    lastFailureMessage: null,
    currentModel: null,
    quota: null,
    lastProbeAt: null,
    ...overrides,
  };
}

function makeManager(
  overrides: Partial<Record<ProviderId, Partial<ProviderHealth>>> = {},
): ProviderHealthManager {
  const entries = new Map<ProviderId, ProviderHealth>();
  const labelMap: Record<ProviderId, ProviderLabel> = {
    gemini: "Gemini",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    cloudflare: "Cloudflare",
  };
  for (const id of ["gemini", "openai", "openrouter", "cloudflare"] as ProviderId[]) {
    entries.set(id, makeHealth({ providerId: id, provider: labelMap[id], ...overrides[id] }));
  }

  const result = {
    config: {
      failureThreshold: 5,
      latencySamples: 20,
      assumedLatencyMs: 1_500,
      halfOpenTrialTimeoutMs: 30_000,
    } as const,
    get: (id: ProviderId) => entries.get(id)!,
    getAll: () =>
      (["gemini", "openai", "openrouter", "cloudflare"] as ProviderId[]).map((id) =>
        entries.get(id)!,
      ) as ProviderHealth[],
    getMany: (ids: ProviderId[]) => ids.map((id) => entries.get(id)!) as ProviderHealth[],
    isAvailable: () => true,
    isInCooldown: () => false,
    getSkip: () => null,
    getCooldownRemainingMs: () => 0,
    circuitState: () => "closed" as const,
    setConfigured: () => {},
    clearConfigurationHold: () => {},
    recordSuccess: () => {},
    recordFailure: () => ({
      provider: "gemini" as ProviderId,
      kind: "server_error",
      cooldownMs: 0,
      cooldownUntil: null,
      circuitState: "closed" as const,
      circuitOpened: false,
      disabledUntilConfigChange: false,
      consecutiveFailures: 0,
    }),
    acquireProbeSlot: () => true,
    releaseProbeSlot: () => {},
    getProvidersAwaitingRecovery: () => [] as ProviderId[],
    recordRecoverySuccess: () => {},
    recordRecoveryFailure: () => ({
      provider: "gemini" as ProviderId,
      kind: "server_error",
      cooldownMs: 0,
      cooldownUntil: null,
      circuitState: "closed" as const,
      circuitOpened: false,
      disabledUntilConfigChange: false,
      consecutiveFailures: 0,
    }),
    effectiveLatencyMs: (id: ProviderId) => entries.get(id)!.averageLatencyMs,
    reset: () => {},
  };
  return result as unknown as ProviderHealthManager;
}

// ---------------------------------------------------------------------------
// 1. rankProviders (createProviderRouter isn't a real export)
// ---------------------------------------------------------------------------
describe("rankProviders", () => {
  it("returns providers sorted by status then latency then success rate", () => {
    const manager = makeManager({
      gemini: makeHealth({ status: "healthy", averageLatencyMs: 100, successRate: 0.99 }),
      openai: makeHealth({ status: "degraded", averageLatencyMs: 50, successRate: 0.99 }),
      openrouter: makeHealth({ status: "healthy", averageLatencyMs: 80, successRate: 0.95 }),
      cloudflare: makeHealth({ status: "healthy", averageLatencyMs: 100, successRate: 0.99 }),
    });

    const ranked = rankProviders(manager, ["gemini", "openai", "openrouter", "cloudflare"]);
    // healthy before degraded, latency bucketed, success rate as tie-break
    expect(ranked[0]).not.toBe("openai");
  });

  it("deduplicates providers", () => {
    const manager = makeManager();
    const ranked = rankProviders(manager, ["gemini", "gemini", "openai"]);
    expect(ranked).toEqual(["gemini", "openai"]);
  });

  it("uses preferred order as final tie-break", () => {
    const manager = makeManager({
      gemini: makeHealth({ status: "healthy", averageLatencyMs: 100, successRate: 0.99 }),
      openai: makeHealth({ status: "healthy", averageLatencyMs: 100, successRate: 0.99 }),
      openrouter: makeHealth({ status: "healthy", averageLatencyMs: 100, successRate: 0.99 }),
      cloudflare: makeHealth({ status: "healthy", averageLatencyMs: 100, successRate: 0.99 }),
    });

    const ranked = rankProviders(
      manager,
      ["openrouter", "openai", "gemini"],
      ["openrouter", "openai", "gemini"],
    );
    expect(ranked).toEqual(["openrouter", "openai", "gemini"]);
  });

  it("respects effectiveLatencyMs for ranking", () => {
    const manager = makeManager({
      gemini: makeHealth({ providerId: "gemini", status: "healthy", averageLatencyMs: 50 }),
      openai: makeHealth({ providerId: "openai", status: "healthy", averageLatencyMs: 200 }),
      openrouter: makeHealth({
        providerId: "openrouter",
        status: "healthy",
        averageLatencyMs: 200,
      }),
      cloudflare: makeHealth({
        providerId: "cloudflare",
        status: "healthy",
        averageLatencyMs: 200,
      }),
    });

    const ranked = rankProviders(manager, ["openai", "gemini"]);
    expect(ranked[0]).toBe("gemini");
    expect(ranked[1]).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// 2. getSkip via selectEligibleProviders
// ---------------------------------------------------------------------------
describe("selectEligibleProviders getSkip behavior", () => {
  it("includes provider when manager.getSkip returns null", () => {
    const manager = makeManager();
    const { eligible, skipped } = selectEligibleProviders(manager, ["gemini"]);
    expect(eligible).toEqual(["gemini"]);
    expect(skipped).toHaveLength(0);
  });

  it("skips provider when manager.getSkip returns a reason", () => {
    const skip: ProviderSkip = {
      provider: "gemini",
      code: "cooldown",
      detail: "In cooldown",
    };

    const manager = {
      ...makeManager(),
      getSkip: () => skip,
    };

    const { eligible, skipped } = selectEligibleProviders(manager, ["gemini"]);
    expect(eligible).toHaveLength(0);
    expect(skipped).toContainEqual(skip);
  });
});

// ---------------------------------------------------------------------------
// 3. createRequestRoutingContext
// ---------------------------------------------------------------------------
describe("createRequestRoutingContext", () => {
  it("creates a context with requestId and requestStartedAt", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    expect(ctx.requestId).toBe("req-1");
    expect(ctx.requestStartedAt).toBe(tick);
  });

  it("starts with empty attempted/failure lists", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    expect(ctx.attemptedProviders).toHaveLength(0);
    expect(ctx.failures).toHaveLength(0);
    expect(ctx.exhaustedProviders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. RequestRoutingContext.getSkip
// ---------------------------------------------------------------------------
describe("RequestRoutingContext.getSkip", () => {
  it("returns null when no failure recorded", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    expect(ctx.getSkip("gemini")).toBeNull();
  });

  it("returns skip after a provider-scoped failure", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    ctx.recordFailure({ provider: "gemini", kind: "server_error", status: 500 });

    const skip = ctx.getSkip("gemini");
    expect(skip).not.toBeNull();
    expect(skip?.code).toBe("already_failed_this_request");
    expect(skip?.provider).toBe("gemini");
  });

  it("returns null after a non-provider-scoped failure", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    ctx.recordFailure({ provider: "gemini", kind: "invalid_request" });

    expect(ctx.getSkip("gemini")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. RequestRoutingContext.markAttempt
// ---------------------------------------------------------------------------
describe("RequestRoutingContext.markAttempt", () => {
  it("tracks attempted providers", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });

    ctx.markAttempt("gemini", "gemini-2.0-flash");
    ctx.markAttempt("openai", "gpt-4o");

    expect(ctx.attemptedProviders).toEqual(["gemini", "openai"]);
    expect(ctx.hasAttempted("gemini", "gemini-2.0-flash")).toBe(true);
    expect(ctx.hasAttempted("openai", "gpt-4o")).toBe(true);
    expect(ctx.hasAttempted("gemini", "other-model")).toBe(false);
  });

  it("does not duplicate provider in attemptedProviders", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    ctx.markAttempt("gemini", "model-a");
    ctx.markAttempt("gemini", "model-b");

    expect(ctx.attemptedProviders).toEqual(["gemini"]);
  });

  it("tracks model exclusions after provider-scoped failure", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    ctx.recordFailure({ provider: "gemini", kind: "server_error", model: "gemini-2.0-flash" });

    expect(ctx.isModelExcluded("gemini", "gemini-2.0-flash")).toBe(true);
    expect(ctx.isModelExcluded("gemini", "other-model")).toBe(false);
  });

  it("returns true from recordFailure for provider-scoped errors", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    expect(ctx.recordFailure({ provider: "gemini", kind: "server_error" })).toBe(true);
  });

  it("returns false from recordFailure for non-provider-scoped errors", () => {
    tick = 1_000_000_000_000;
    const ctx = createRequestRoutingContext("req-1", { now: () => tick });
    expect(ctx.recordFailure({ provider: "gemini", kind: "invalid_request" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------
describe("compareProviderRanking", () => {
  it("healthy outranks degraded", () => {
    const a = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.9,
      failureCount: 0,
    });
    const b = makeHealth({
      status: "degraded",
      averageLatencyMs: 50,
      successRate: 0.9,
      failureCount: 1,
    });
    expect(
      compareProviderRanking(
        { provider: "gemini", health: a, latencyMs: 100, preferenceIndex: 0 },
        { provider: "openai", health: b, latencyMs: 50, preferenceIndex: 0 },
      ),
    ).toBeLessThan(0);
  });

  it("rates higher success rate outranks lower", () => {
    const a = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.99,
      failureCount: 0,
    });
    const b = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.5,
      failureCount: 0,
    });
    expect(
      compareProviderRanking(
        { provider: "gemini", health: a, latencyMs: 100, preferenceIndex: 0 },
        { provider: "openai", health: b, latencyMs: 100, preferenceIndex: 0 },
      ),
    ).toBeLessThan(0);
  });

  it("fewer failures outranks more", () => {
    const a = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.9,
      failureCount: 0,
    });
    const b = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.9,
      failureCount: 2,
    });
    expect(
      compareProviderRanking(
        { provider: "gemini", health: a, latencyMs: 100, preferenceIndex: 0 },
        { provider: "openai", health: b, latencyMs: 100, preferenceIndex: 0 },
      ),
    ).toBeLessThan(0);
  });

  it("uses preferenceIndex as final tie-break", () => {
    const a = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.9,
      failureCount: 0,
    });
    const b = makeHealth({
      status: "healthy",
      averageLatencyMs: 100,
      successRate: 0.9,
      failureCount: 0,
    });
    const result = compareProviderRanking(
      { provider: "gemini", health: a, latencyMs: 100, preferenceIndex: 1 },
      { provider: "openai", health: b, latencyMs: 100, preferenceIndex: 0 },
    );
    expect(result).toBeGreaterThan(0); // openai preferred, so gemini ranks lower
  });
});

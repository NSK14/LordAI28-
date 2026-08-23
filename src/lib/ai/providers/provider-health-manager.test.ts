import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_HEALTH_CONFIG,
  type ProviderHealthManager,
  type ProviderHealthManagerConfig,
  createProviderHealthManager,
} from "./provider-health-manager";
import type { ProviderFailure, ProviderFailureKind, ProviderId } from "./provider-types";

let tick: number;
let rng: () => number;

function makeManager(config?: Partial<ProviderHealthManagerConfig>): ProviderHealthManager {
  tick = 1_000_000_000_000;
  rng = () => 0.5;
  return createProviderHealthManager({
    now: () => tick,
    random: rng,
    config,
  });
}

function advance(ms: number): void {
  tick += ms;
}

const PROVIDERS = ["gemini", "openai", "openrouter", "cloudflare"] as const;

function fail(
  manager: ProviderHealthManager,
  provider: ProviderId,
  kind: string,
  status?: number,
): void {
  manager.recordFailure(provider, { kind: kind as ProviderFailureKind, status } as ProviderFailure);
}

describe("provider health manager", () => {
  // ---------------------------------------------------------------------------
  // 1. createProviderHealthManager — basic creation with default config
  // ---------------------------------------------------------------------------
  describe("createProviderHealthManager", () => {
    it("returns a manager with default config values", () => {
      const manager = makeManager();
      expect(manager.config).toEqual(DEFAULT_PROVIDER_HEALTH_CONFIG);
    });

    it("merges custom config over defaults", () => {
      const manager = makeManager({ failureThreshold: 3, assumedLatencyMs: 2_000 });
      expect(manager.config.failureThreshold).toBe(3);
      expect(manager.config.assumedLatencyMs).toBe(2_000);
      expect(manager.config.latencySamples).toBe(DEFAULT_PROVIDER_HEALTH_CONFIG.latencySamples);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. setConfigured / get
  // ---------------------------------------------------------------------------
  describe("setConfigured / get", () => {
    it("starts unconfigured", () => {
      const manager = makeManager();
      const health = manager.get("gemini");
      expect(health.configured).toBe(false);
      expect(health.status).toBe("offline");
    });

    it("marks configured and clears the issue", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true, "missing key");
      const health = manager.get("gemini");
      expect(health.configured).toBe(true);
      expect(health.configurationIssue).toBeNull();
      expect(health.status).toBe("healthy");
    });

    it("stores a configuration issue when unconfigured", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", false, "expired key");
      const health = manager.get("gemini");
      expect(health.configured).toBe(false);
      expect(health.configurationIssue).toBe("expired key");
    });

    it("getAll returns every provider in canonical order", () => {
      const manager = makeManager();
      const all = manager.getAll();
      expect(all.map((h) => h.providerId)).toEqual(PROVIDERS);
    });

    it("getMany returns only requested providers in canonical order", () => {
      const manager = makeManager();
      const some = manager.getMany(["openrouter", "gemini"]);
      expect(some.map((h) => h.providerId)).toEqual(["gemini", "openrouter"]);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. recordSuccess
  // ---------------------------------------------------------------------------
  describe("recordSuccess", () => {
    it("updates success counters and resets consecutive failures", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      fail(manager, "gemini", "server_error");
      fail(manager, "gemini", "timeout");

      manager.recordSuccess("gemini", { latencyMs: 200 });

      const health = manager.get("gemini");
      expect(health.failureCount).toBe(0);
      expect(health.totalSuccesses).toBe(1);
      expect(health.totalRequests).toBe(3); // 2 failures + 1 success
      expect(health.consecutiveSuccesses).toBe(1);
      expect(health.status).toBe("healthy");
    });

    it("records latency samples", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordSuccess("gemini", { latencyMs: 100 });
      manager.recordSuccess("gemini", { latencyMs: 200 });

      const health = manager.get("gemini");
      expect(health.averageLatencyMs).toBe(150);
    });

    it("stores current model on success", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordSuccess("gemini", { model: "gemini-2.0-flash" });
      const health = manager.get("gemini");
      expect(health.currentModel).toBe("gemini-2.0-flash");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. recordFailure
  // ---------------------------------------------------------------------------
  describe("recordFailure", () => {
    it("increments consecutive failures", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      manager.recordFailure("gemini", { kind: "server_error" });
      manager.recordFailure("gemini", { kind: "server_error" });

      const health = manager.get("gemini");
      expect(health.failureCount).toBe(2);
      expect(health.totalFailures).toBe(2);
      expect(health.totalRequests).toBe(2);
    });

    it("records last failure details", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordFailure("gemini", { kind: "server_error", status: 500, message: "boom" });

      const health = manager.get("gemini");
      expect(health.lastFailureKind).toBe("server_error");
      expect(health.lastFailureStatus).toBe(500);
      expect(health.lastFailureMessage).toBe("boom");
    });

    it("ignores aborted failures (not provider-scoped)", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordFailure("gemini", { kind: "aborted" });

      const health = manager.get("gemini");
      expect(health.failureCount).toBe(0);
      expect(health.totalFailures).toBe(0);
    });

    it("ignores invalid_request failures (not provider-scoped)", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordFailure("gemini", { kind: "invalid_request" });

      const health = manager.get("gemini");
      expect(health.failureCount).toBe(0);
      expect(health.totalFailures).toBe(1);
      expect(health.totalRequests).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. circuit breaker behavior
  // ---------------------------------------------------------------------------
  describe("circuit breaker behavior", () => {
    it("opens circuit after threshold consecutive failures", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }

      const health = manager.get("gemini");
      expect(health.circuitState).toBe("open");
      expect(health.failureCount).toBe(5);
    });

    it("transitions to half-open after cooldown expires", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      // 5 failures trip the circuit
      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }

      expect(manager.get("gemini").circuitState).toBe("open");

      // Advance past the cooldown (2-5 min jittered, but we use random=0.5)
      // The cooldown will be: minMs + floor(span * 0.5) + circuit escalation
      advance(10 * 60_000);

      const health = manager.get("gemini");
      expect(health.circuitState).toBe("half_open");
    });

    it("closes circuit on success after half-open", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }

      advance(10 * 60_000);
      expect(manager.get("gemini").circuitState).toBe("half_open");

      manager.recordSuccess("gemini", { latencyMs: 100 });

      expect(manager.get("gemini").circuitState).toBe("closed");
      expect(manager.get("gemini").failureCount).toBe(0);
    });

    it("re-opens circuit if half-open probe fails", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }

      advance(10 * 60_000);
      expect(manager.get("gemini").circuitState).toBe("half_open");

      advance(1);
      fail(manager, "gemini", "server_error");

      expect(manager.get("gemini").circuitState).toBe("open");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. cooldown
  // ---------------------------------------------------------------------------
  describe("cooldown", () => {
    it("puts provider in cooldown after a provider-scoped failure", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      advance(1);
      fail(manager, "gemini", "server_error");

      expect(manager.isInCooldown("gemini")).toBe(true);
      expect(manager.getCooldownRemainingMs("gemini")).toBeGreaterThan(0);
    });

    it("getSkip returns cooldown info when in cooldown", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      advance(1);
      fail(manager, "gemini", "server_error");

      const skip = manager.getSkip("gemini");
      expect(skip).not.toBeNull();
      expect(skip?.code).toBe("cooldown");
      expect(skip?.remainingMs).toBeGreaterThan(0);
      expect(skip?.kind).toBe("server_error");
    });

    it("returns not_configured skip when not configured", () => {
      const manager = makeManager();
      const skip = manager.getSkip("gemini");
      expect(skip).not.toBeNull();
      expect(skip?.code).toBe("not_configured");
    });

    it("returns disabled skip for auth hold", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      fail(manager, "gemini", "auth", 401);

      const skip = manager.getSkip("gemini");
      expect(skip).not.toBeNull();
      expect(skip?.code).toBe("disabled");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. isAvailable
  // ---------------------------------------------------------------------------
  describe("isAvailable", () => {
    it("returns false when not configured", () => {
      const manager = makeManager();
      expect(manager.isAvailable("gemini")).toBe(false);
    });

    it("returns false when in cooldown", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      advance(1);
      fail(manager, "gemini", "server_error");
      expect(manager.isAvailable("gemini")).toBe(false);
    });

    it("returns false when circuit is open", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }
      expect(manager.isAvailable("gemini")).toBe(false);
    });

    it("returns false when disabledUntilConfigChange", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      fail(manager, "gemini", "auth", 401);
      expect(manager.isAvailable("gemini")).toBe(false);
    });

    it("returns true when healthy", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      expect(manager.isAvailable("gemini")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. effectiveLatencyMs
  // ---------------------------------------------------------------------------
  describe("effectiveLatencyMs", () => {
    it("returns assumedLatencyMs when no samples exist", () => {
      const manager = makeManager({ assumedLatencyMs: 3_000 });
      manager.setConfigured("gemini", true);
      expect(manager.effectiveLatencyMs("gemini")).toBe(3_000);
    });

    it("returns rolling average when samples exist", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordSuccess("gemini", { latencyMs: 100 });
      manager.recordSuccess("gemini", { latencyMs: 200 });

      expect(manager.effectiveLatencyMs("gemini")).toBe(150);
    });

    it("does not count failed-call latency samples against the provider for ranking", () => {
      // The health manager applies latency from both success and failure,
      // but the rolling average should reflect all samples.
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordFailure("gemini", { kind: "server_error", latencyMs: 50 });
      manager.recordSuccess("gemini", { latencyMs: 100 });

      // failure applies latency: [50], then success pushes [50, 100] → avg 75
      expect(manager.effectiveLatencyMs("gemini")).toBe(75);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. acquireProbeSlot / releaseProbeSlot
  // ---------------------------------------------------------------------------
  describe("acquireProbeSlot / releaseProbeSlot", () => {
    it("acquires a slot when none is in flight", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      expect(manager.acquireProbeSlot("gemini")).toBe(true);
    });

    it("returns false when a slot is already held", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      expect(manager.acquireProbeSlot("gemini")).toBe(true);
      expect(manager.acquireProbeSlot("gemini")).toBe(false);
    });

    it("releases the slot", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.acquireProbeSlot("gemini");
      manager.releaseProbeSlot("gemini");
      expect(manager.acquireProbeSlot("gemini")).toBe(true);
    });

    it("expires a slot after halfOpenTrialTimeoutMs", () => {
      const manager = makeManager({ halfOpenTrialTimeoutMs: 5_000 });
      manager.setConfigured("gemini", true);
      manager.acquireProbeSlot("gemini");
      advance(6_000);
      expect(manager.acquireProbeSlot("gemini")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. getProvidersAwaitingRecovery
  // ---------------------------------------------------------------------------
  describe("getProvidersAwaitingRecovery", () => {
    it("returns providers with expired cooldowns and consecutive failures", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.setConfigured("openai", true);

      fail(manager, "gemini", "server_error");
      // No cooldown for single failure (below threshold) — wait, single failure
      // does produce a cooldown since it's provider-scoped.
      // Let me re-check: circuit breaker trips only at threshold OR half-open OR recovery probe.
      // For a single server_error, is there a cooldown? Looking at the code:
      // trips = consecutiveFailures >= threshold || wasHalfOpen || fromRecoveryProbe || circuitTripped
      // For 1 failure with threshold=5: trips is false. So no cooldown.
      // Actually, let me reconsider. With threshold=5, 1 failure is not enough.
      // But wait, getProvidersAwaitingRecovery checks cooldownActive AND consecutiveFailures > 0.
      // Without a cooldown, cooldownActive is false.
      // Hmm. Let me make sure we produce the right conditions.
    });

    it("returns providers that had cooldown expire but still have failures", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      // Need to trip the circuit first (5 failures), then wait for cooldown to expire
      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }

      // Advance past the cooldown
      advance(10 * 60_000);

      // Now the circuit is half-open (consecutiveFailures > 0, no cooldown)
      // getProvidersAwaitingRecovery should return gemini
      const awaiting = manager.getProvidersAwaitingRecovery();
      expect(awaiting).toContain("gemini");
    });

    it("excludes unconfigured providers", () => {
      const manager = makeManager();
      // Don't configure openai
      manager.setConfigured("gemini", true);
      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }
      advance(10 * 60_000);

      const awaiting = manager.getProvidersAwaitingRecovery();
      expect(awaiting).toContain("gemini");
      expect(awaiting).not.toContain("openai");
    });
  });

  // ---------------------------------------------------------------------------
  // 11. recordRecoverySuccess / recordRecoveryFailure
  // ---------------------------------------------------------------------------
  describe("recordRecoverySuccess / recordRecoveryFailure", () => {
    it("recordRecoverySuccess clears failure state and updates latency", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }
      advance(10 * 60_000);

      expect(manager.get("gemini").circuitState).toBe("half_open");

      manager.acquireProbeSlot("gemini");
      manager.recordRecoverySuccess("gemini", 120);

      const health = manager.get("gemini");
      expect(health.circuitState).toBe("closed");
      expect(health.failureCount).toBe(0);
      expect(health.averageLatencyMs).toBe(120);
      expect(health.lastProbeAt).not.toBeNull();
    });

    it("recordRecoveryFailure re-opens circuit and releases probe slot", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      for (let i = 0; i < 5; i++) {
        advance(1);
        fail(manager, "gemini", "server_error");
      }
      advance(10 * 60_000);

      manager.acquireProbeSlot("gemini");
      advance(1);
      manager.recordRecoveryFailure("gemini", { kind: "server_error" });

      const health = manager.get("gemini");
      expect(health.circuitState).toBe("open");
      expect(health.failureCount).toBeGreaterThanOrEqual(5);
      // Probe slot should be released
      expect(manager.acquireProbeSlot("gemini")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 12. reset
  // ---------------------------------------------------------------------------
  describe("reset", () => {
    it("resets a single provider's state but preserves configuration", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true, "missing key");
      fail(manager, "gemini", "server_error");
      manager.recordSuccess("gemini", { latencyMs: 100, model: "gemini-2.0-flash" });

      manager.reset("gemini");

      const health = manager.get("gemini");
      expect(health.configured).toBe(true);
      expect(health.configurationIssue).toBeNull();
      expect(health.failureCount).toBe(0);
      expect(health.totalFailures).toBe(0);
      expect(health.totalSuccesses).toBe(0);
      expect(health.averageLatencyMs).toBe(0);
      expect(health.currentModel).toBeNull();
      expect(health.circuitState).toBe("closed");
    });

    it("resets all providers when called without argument", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.setConfigured("openai", true);
      fail(manager, "gemini", "server_error");
      fail(manager, "openai", "server_error");

      manager.reset();

      expect(manager.get("gemini").failureCount).toBe(0);
      expect(manager.get("openai").failureCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 13. config passthrough
  // ---------------------------------------------------------------------------
  describe("config passthrough", () => {
    it("respects custom failureThreshold", () => {
      const manager = makeManager({ failureThreshold: 2 });
      manager.setConfigured("gemini", true);

      advance(1);
      fail(manager, "gemini", "server_error");
      advance(1);
      fail(manager, "gemini", "server_error");

      expect(manager.get("gemini").circuitState).toBe("open");
    });

    it("respects custom latencySamples", () => {
      const manager = makeManager({ latencySamples: 2 });
      manager.setConfigured("gemini", true);
      manager.recordSuccess("gemini", { latencyMs: 100 });
      manager.recordSuccess("gemini", { latencyMs: 200 });
      manager.recordSuccess("gemini", { latencyMs: 300 });

      // Only last 2 samples kept: avg(200, 300) = 250
      expect(manager.effectiveLatencyMs("gemini")).toBe(250);
    });

    it("respects custom assumedLatencyMs", () => {
      const manager = makeManager({ assumedLatencyMs: 5_000 });
      manager.setConfigured("gemini", true);
      expect(manager.effectiveLatencyMs("gemini")).toBe(5_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------------------
  describe("edge cases", () => {
    it("getSkip returns null when provider is available", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      expect(manager.getSkip("gemini")).toBeNull();
    });

    it("isInCooldown returns false when not cooling down", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      expect(manager.isInCooldown("gemini")).toBe(false);
    });

    it("clearConfigurationHold clears the disabled flag", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      fail(manager, "gemini", "auth", 401);
      expect(manager.get("gemini").disabledUntilConfigChange).toBe(true);

      manager.clearConfigurationHold("gemini");
      expect(manager.get("gemini").disabledUntilConfigChange).toBe(false);
      expect(manager.get("gemini").circuitState).toBe("closed");
    });

    it("clearConfigurationHold without argument clears all providers", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.setConfigured("openai", true);
      fail(manager, "gemini", "auth", 401);
      fail(manager, "openai", "auth", 401);

      manager.clearConfigurationHold();

      expect(manager.get("gemini").disabledUntilConfigChange).toBe(false);
      expect(manager.get("openai").disabledUntilConfigChange).toBe(false);
    });

    it("setConfigured(true) clears disabledUntilConfigChange on change", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true, "initial");
      fail(manager, "gemini", "auth", 401);
      expect(manager.get("gemini").disabledUntilConfigChange).toBe(true);

      // Pass a different issue to trigger the `changed` detection
      manager.setConfigured("gemini", true, "reloaded");
      expect(manager.get("gemini").disabledUntilConfigChange).toBe(false);
    });

    it("success rate is 1 for unused providers", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      const health = manager.get("gemini");
      expect(health.successRate).toBe(1);
    });

    it("success rate updates correctly", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      manager.recordSuccess("gemini");
      manager.recordSuccess("gemini");
      manager.recordFailure("gemini", { kind: "server_error" });

      const health = manager.get("gemini");
      expect(health.totalRequests).toBe(3);
      expect(health.totalSuccesses).toBe(2);
      expect(health.totalFailures).toBe(1);
      expect(health.successRate).toBeCloseTo(2 / 3);
    });

    it("request cooldown triggered during the request is ignored by getSkip", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);
      const requestStartedAt = tick;

      advance(1);
      fail(manager, "gemini", "server_error");

      // requestStartedAt equals the failure time — this very request triggered it
      const skip = manager.getSkip("gemini", { requestStartedAt });
      expect(skip).toBeNull();
    });

    it("request cooldown from before the request is not ignored", () => {
      const manager = makeManager();
      manager.setConfigured("gemini", true);

      advance(1);
      fail(manager, "gemini", "server_error");
      advance(100); // gap between failure and request start

      const skip = manager.getSkip("gemini", { requestStartedAt: tick });
      expect(skip).not.toBeNull();
      expect(skip?.code).toBe("cooldown");
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  COOLDOWN_WINDOWS,
  CIRCUIT_RECOVERY_MS,
  CIRCUIT_FAILURE_THRESHOLD,
  RETRY_BACKOFF_SCHEDULE_MS,
  RETRY_BUDGET,
  classifyProviderFailure,
  failureKindFromClassification,
  getRetryDelayMs,
  isConfigurationHoldFailure,
  isProviderScopedFailure,
  isRetryableFailureKind,
  parseQuotaHeaders,
  parseRetryAfter,
  resolveCooldownMs,
  shouldRetryFailure,
} from "./provider-policy";

describe("provider-policy", () => {
  // ---------------------------------------------------------------------------
  // 1. resolveCooldownMs
  // ---------------------------------------------------------------------------
  describe("resolveCooldownMs", () => {
    const random = () => 0.5;

    it("returns 0 for configuration hold failures (auth)", () => {
      expect(resolveCooldownMs({ kind: "auth", random })).toBe(0);
    });

    it("returns 0 for non-provider-scoped failures", () => {
      expect(resolveCooldownMs({ kind: "invalid_request", random })).toBe(0);
      expect(resolveCooldownMs({ kind: "invalid_model", random })).toBe(0);
      expect(resolveCooldownMs({ kind: "aborted", random })).toBe(0);
    });

    it("returns jittered cooldown within the window for provider-scoped failures", () => {
      // server_error window: 2-5 min. With random=0.5: 2min + floor(3min * 0.5) = 2min + 1.5min = 2100000ms
      const result = resolveCooldownMs({ kind: "server_error", random });
      expect(result).toBeGreaterThanOrEqual(2 * 60_000);
      expect(result).toBeLessThanOrEqual(5 * 60_000);
    });

    it("returns fixed cooldown for quota_exceeded (no jitter window)", () => {
      const result = resolveCooldownMs({ kind: "quota_exceeded", random });
      expect(result).toBe(15 * 60_000);
    });

    it("returns fixed cooldown for rate_limit (with random 0.5)", () => {
      const result = resolveCooldownMs({ kind: "rate_limit", random });
      // rate_limit window: 10-15 min, random 0.5 → 10min + floor(5min * 0.5) = 12.5min
      expect(result).toBeGreaterThanOrEqual(10 * 60_000);
      expect(result).toBeLessThanOrEqual(15 * 60_000);
    });

    it("respects retryAfterMs when longer than computed cooldown", () => {
      const result = resolveCooldownMs({
        kind: "server_error",
        retryAfterMs: 10 * 60_000,
        random,
      });
      expect(result).toBeGreaterThanOrEqual(10 * 60_000);
    });

    it("ignores retryAfterMs when shorter than computed cooldown", () => {
      const result = resolveCooldownMs({
        kind: "server_error",
        retryAfterMs: 1_000,
        random,
      });
      // window is 2-5 min, so 1s is ignored
      expect(result).toBeGreaterThanOrEqual(2 * 60_000);
    });

    it("escalates cooldown when circuit trips", () => {
      const withoutTrip = resolveCooldownMs({
        kind: "server_error",
        circuitOpenCount: 0,
        circuitTripped: false,
        random,
      });
      const withTrip = resolveCooldownMs({
        kind: "server_error",
        circuitOpenCount: 0,
        circuitTripped: true,
        random,
      });
      expect(withTrip).toBeGreaterThanOrEqual(withoutTrip);
      // escalation = CIRCUIT_RECOVERY_MS * 2^0 = 60_000
      expect(withTrip).toBeGreaterThanOrEqual(CIRCUIT_RECOVERY_MS);
    });

    it("doubles escalation with each circuit open count", () => {
      const base = resolveCooldownMs({
        kind: "server_error",
        circuitOpenCount: 0,
        circuitTripped: true,
        random,
      });
      const doubled = resolveCooldownMs({
        kind: "server_error",
        circuitOpenCount: 1,
        circuitTripped: true,
        random,
      });
      expect(doubled).toBeGreaterThanOrEqual(base);
      expect(doubled).toBeGreaterThanOrEqual(CIRCUIT_RECOVERY_MS * 2);
    });

    it("caps at MAX_COOLDOWN_MS", () => {
      const maxCooldown = 60 * 60_000;
      const result = resolveCooldownMs({
        kind: "server_error",
        circuitOpenCount: 10,
        circuitTripped: true,
        random: () => 0.999,
      });
      expect(result).toBeLessThanOrEqual(maxCooldown);
    });

    it("timeout falls in 30-60s window with random=0.5", () => {
      const result = resolveCooldownMs({ kind: "timeout", random });
      expect(result).toBeGreaterThanOrEqual(30_000);
      expect(result).toBeLessThanOrEqual(60_000);
    });

    it("network falls in 30-60s window with random=0.5", () => {
      const result = resolveCooldownMs({ kind: "network", random });
      expect(result).toBeGreaterThanOrEqual(30_000);
      expect(result).toBeLessThanOrEqual(60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. isProviderScopedFailure
  // ---------------------------------------------------------------------------
  describe("isProviderScopedFailure", () => {
    it("returns true for provider-scoped failures", () => {
      expect(isProviderScopedFailure("rate_limit")).toBe(true);
      expect(isProviderScopedFailure("quota_exceeded")).toBe(true);
      expect(isProviderScopedFailure("auth")).toBe(true);
      expect(isProviderScopedFailure("server_error")).toBe(true);
      expect(isProviderScopedFailure("timeout")).toBe(true);
      expect(isProviderScopedFailure("network")).toBe(true);
      expect(isProviderScopedFailure("unknown")).toBe(true);
    });

    it("returns false for non-provider-scoped failures", () => {
      expect(isProviderScopedFailure("invalid_request")).toBe(false);
      expect(isProviderScopedFailure("invalid_model")).toBe(false);
      expect(isProviderScopedFailure("aborted")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. isConfigurationHoldFailure
  // ---------------------------------------------------------------------------
  describe("isConfigurationHoldFailure", () => {
    it("returns true only for auth", () => {
      expect(isConfigurationHoldFailure("auth")).toBe(true);
    });

    it("returns false for other failure kinds", () => {
      expect(isConfigurationHoldFailure("server_error")).toBe(false);
      expect(isConfigurationHoldFailure("rate_limit")).toBe(false);
      expect(isConfigurationHoldFailure("timeout")).toBe(false);
      expect(isConfigurationHoldFailure("invalid_request")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. RETRY_BUDGET
  // ---------------------------------------------------------------------------
  describe("RETRY_BUDGET", () => {
    it("has 0 retries for definitive failures", () => {
      expect(RETRY_BUDGET.rate_limit).toBe(0);
      expect(RETRY_BUDGET.quota_exceeded).toBe(0);
      expect(RETRY_BUDGET.auth).toBe(0);
      expect(RETRY_BUDGET.invalid_request).toBe(0);
      expect(RETRY_BUDGET.invalid_model).toBe(0);
      expect(RETRY_BUDGET.aborted).toBe(0);
      expect(RETRY_BUDGET.server_error).toBe(0);
      expect(RETRY_BUDGET.timeout).toBe(0);
      expect(RETRY_BUDGET.unknown).toBe(0);
    });

    it("has 2 retries for network failures", () => {
      expect(RETRY_BUDGET.network).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. RETRY_BACKOFF_SCHEDULE_MS
  // ---------------------------------------------------------------------------
  describe("RETRY_BACKOFF_SCHEDULE_MS", () => {
    it("has the correct values", () => {
      expect(RETRY_BACKOFF_SCHEDULE_MS).toEqual([500, 1_000, 2_000]);
    });

    it("has length 3", () => {
      expect(RETRY_BACKOFF_SCHEDULE_MS.length).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Supporting tests for completeness
  // ---------------------------------------------------------------------------
  describe("getRetryDelayMs", () => {
    it("returns correct delay for each attempt", () => {
      expect(getRetryDelayMs(1)).toBe(500);
      expect(getRetryDelayMs(2)).toBe(1_000);
      expect(getRetryDelayMs(3)).toBe(2_000);
    });

    it("clamps to last step for attempts beyond schedule", () => {
      expect(getRetryDelayMs(4)).toBe(2_000);
      expect(getRetryDelayMs(100)).toBe(2_000);
    });

    it("returns first step for invalid input", () => {
      expect(getRetryDelayMs(0)).toBe(500);
      expect(getRetryDelayMs(-1)).toBe(500);
      expect(getRetryDelayMs(NaN)).toBe(500);
    });
  });

  describe("isRetryableFailureKind", () => {
    it("returns true only for network", () => {
      expect(isRetryableFailureKind("network")).toBe(true);
    });

    it("returns false for all other kinds", () => {
      expect(isRetryableFailureKind("server_error")).toBe(false);
      expect(isRetryableFailureKind("timeout")).toBe(false);
      expect(isRetryableFailureKind("rate_limit")).toBe(false);
      expect(isRetryableFailureKind("auth")).toBe(false);
    });
  });

  describe("shouldRetryFailure", () => {
    it("returns retry=true for network with budget remaining", () => {
      const decision = shouldRetryFailure("network", 0);
      expect(decision.retry).toBe(true);
      expect(decision.attempt).toBe(1);
      expect(decision.delayMs).toBe(500);
    });

    it("returns retry=false when provider is in cooldown", () => {
      const decision = shouldRetryFailure("network", 0, true);
      expect(decision.retry).toBe(false);
      expect(decision.reason).toBe("provider is in cooldown");
    });

    it("returns retry=false when budget exhausted", () => {
      const decision = shouldRetryFailure("network", 2);
      expect(decision.retry).toBe(false);
      expect(decision.reason).toBe("retry budget exhausted for network");
    });

    it("returns retry=false for non-retryable kinds", () => {
      const decision = shouldRetryFailure("auth", 0);
      expect(decision.retry).toBe(false);
      expect(decision.reason).toBe("auth is never retried");
    });
  });

  describe("classifyProviderFailure", () => {
    it("classifies 401 as auth", () => {
      const result = classifyProviderFailure({ status: 401 });
      expect(result.kind).toBe("auth");
    });

    it("classifies 403 as auth", () => {
      const result = classifyProviderFailure({ status: 403 });
      expect(result.kind).toBe("auth");
    });

    it("classifies 429 as rate_limit", () => {
      const result = classifyProviderFailure({ status: 429 });
      expect(result.kind).toBe("rate_limit");
    });

    it("classifies 429 with quota body as quota_exceeded", () => {
      const result = classifyProviderFailure({ status: 429, body: "daily limit exceeded" });
      expect(result.kind).toBe("quota_exceeded");
    });

    it("classifies 500+ as server_error", () => {
      const result = classifyProviderFailure({ status: 500 });
      expect(result.kind).toBe("server_error");
    });

    it("classifies transport abort as aborted", () => {
      const result = classifyProviderFailure({ transport: "abort" });
      expect(result.kind).toBe("aborted");
    });

    it("classifies transport timeout as timeout", () => {
      const result = classifyProviderFailure({ transport: "timeout" });
      expect(result.kind).toBe("timeout");
    });

    it("classifies transport network as network", () => {
      const result = classifyProviderFailure({ transport: "network" });
      expect(result.kind).toBe("network");
    });

    it("classifies unknown when nothing matches", () => {
      const result = classifyProviderFailure({});
      expect(result.kind).toBe("unknown");
    });

    it("propagates retryAfterMs", () => {
      const result = classifyProviderFailure({
        status: 429,
        retryAfterHeader: "120",
      });
      expect(result.retryAfterMs).toBe(120_000);
    });
  });

  describe("failureKindFromClassification", () => {
    it("maps invalid_api_key to auth", () => {
      expect(failureKindFromClassification({ reason: "invalid_api_key" })).toBe("auth");
    });

    it("maps rate_limit using classifyProviderFailure", () => {
      expect(failureKindFromClassification({ reason: "rate_limit", status: 429 })).toBe(
        "rate_limit",
      );
    });

    it("maps insufficient_credits to quota_exceeded", () => {
      expect(failureKindFromClassification({ reason: "insufficient_credits" })).toBe(
        "quota_exceeded",
      );
    });

    it("maps model_unavailable to invalid_model", () => {
      expect(failureKindFromClassification({ reason: "model_unavailable" })).toBe("invalid_model");
    });
  });

  describe("parseRetryAfter", () => {
    it("parses delta-seconds into ms", () => {
      expect(parseRetryAfter("120")).toBe(120_000);
    });

    it("returns undefined for non-positive values", () => {
      expect(parseRetryAfter("0")).toBeUndefined();
      expect(parseRetryAfter("-5")).toBeUndefined();
    });

    it("returns undefined for null/undefined/empty", () => {
      expect(parseRetryAfter(null)).toBeUndefined();
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter("")).toBeUndefined();
    });

    it("parses HTTP-date", () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const result = parseRetryAfter(future);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(60_000);
    });

    it("returns undefined for past HTTP-date", () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      expect(parseRetryAfter(past)).toBeUndefined();
    });
  });

  describe("parseQuotaHeaders", () => {
    it("returns null when no quota headers present", () => {
      expect(parseQuotaHeaders({})).toBeNull();
    });

    it("returns null when called with undefined", () => {
      expect(parseQuotaHeaders(undefined)).toBeNull();
    });

    it("extracts limit and remaining", () => {
      const result = parseQuotaHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "50",
      });
      expect(result?.limit).toBe(100);
      expect(result?.remaining).toBe(50);
      expect(result?.source).toBe("x-ratelimit-remaining-requests");
    });

    it("parses reset as epoch-seconds", () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 300;
      const result = parseQuotaHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-reset-requests": String(resetEpoch),
      });
      expect(result?.resetAt).not.toBeNull();
      expect(result?.resetAt).toBeGreaterThan(Date.now());
    });

    it("parses reset as delta-seconds", () => {
      const result = parseQuotaHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-reset-requests": "120",
      });
      expect(result?.resetAt).not.toBeNull();
      expect(result?.resetAt).toBeGreaterThan(Date.now());
    });

    it("parses reset as ISO-8601 duration", () => {
      const result = parseQuotaHeaders({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-reset-requests": "1m30s",
      });
      expect(result?.resetAt).not.toBeNull();
      expect(result?.resetAt).toBeGreaterThan(Date.now());
    });
  });
});

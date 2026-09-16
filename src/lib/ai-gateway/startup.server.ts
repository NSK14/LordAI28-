import {
  classifyModelError,
  type ModelAttempt,
  PROVIDER_CONFIG,
  LORD_MODE_LABELS,
  type LordMode,
} from "../lord-config";
import { GATEWAY_CONFIG } from "../gateway-config";
import { createLogger, type Logger } from "../gateway-logger";
import {
  getCachedCandidate,
  getGatewayInfrastructure,
  type GatewayInfrastructure,
  resetGatewayInfrastructure,
} from "./infrastructure.server";
import { type LordProvidersState, type ProviderName } from "./providers.server";

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

export interface StartupValidationResult {
  provider: string;
  healthy: string[];
  unhealthy: Array<{ model: string; reason: string; status?: string }>;
  disabledModels: Array<{ model: string; reason: string; disabledUntil: number }>;
}

export async function validateProvidersAtStartup(
  state: LordProvidersState,
  infra: GatewayInfrastructure,
): Promise<StartupValidationResult[]> {
  const results: StartupValidationResult[] = [];
  const providerOrder: Array<{ name: string; provider: ProviderName }> = [
    { name: "Gemini", provider: "gemini" },
    { name: "OpenRouter", provider: "openrouter" },
    { name: "OpenAI", provider: "openai" },
  ];

  for (const { name, provider } of providerOrder) {
    const prov = state.providers[provider];
    const healthy: string[] = [];
    const unhealthy: Array<{ model: string; reason: string; status?: string }> = [];
    const disabledModels: Array<{ model: string; reason: string; disabledUntil: number }> = [];

    if (!prov) {
      const models = PROVIDER_CONFIG[provider].models;
      for (const modelId of models) {
        unhealthy.push({ model: modelId, reason: "Provider not configured (missing API key)" });
      }
      results.push({ provider: name, healthy, unhealthy, disabledModels });
      continue;
    }

    const models = PROVIDER_CONFIG[provider].models;
    for (const modelId of models) {
      const existingEntry = infra.healthCache.get(provider, modelId);
      if (existingEntry && existingEntry.status !== "healthy") {
        disabledModels.push({
          model: modelId,
          reason: existingEntry.reason,
          disabledUntil: existingEntry.expiresAt,
        });
        continue;
      }

      try {
        const { streamText } = await import("ai");
        await streamText({
          model: prov(modelId),
          system: "Reply with OK",
          messages: [{ role: "user", content: "OK" }],
          maxOutputTokens:
            GATEWAY_CONFIG.probeMaxOutputTokensByProvider[provider] ??
            GATEWAY_CONFIG.probeMaxOutputTokens,
          temperature: 0,
          maxRetries: 0,
          timeout: GATEWAY_CONFIG.startupValidationTimeoutMs,
        });
        healthy.push(modelId);
        infra.healthCache.set({
          provider,
          model: modelId,
          status: "healthy",
          reason: "",
          timestamp: Date.now(),
          expiresAt: Date.now() + GATEWAY_CONFIG.healthCacheDefaultTtlMs,
        });
        infra.circuitBreaker.recordSuccess(provider, modelId);
      } catch (err) {
        const classification = classifyModelError(err);
        const reasonLabel =
          GATEWAY_CONFIG.errorReasonLabels[classification.reason] ?? classification.reason;
        const statusStr =
          classification.status !== undefined ? String(classification.status) : undefined;
        unhealthy.push({ model: modelId, reason: reasonLabel, status: statusStr });
        if (classification.retryable) {
          disabledModels.push({
            model: modelId,
            reason: reasonLabel,
            disabledUntil:
              Date.now() + infra.healthCache.getTtlForStatus(classification.status ?? "unknown"),
          });
        }
        infra.healthCache.set({
          provider,
          model: modelId,
          status: classification.retryable ? "unavailable" : "invalid",
          reason: reasonLabel,
          timestamp: Date.now(),
          expiresAt:
            Date.now() + infra.healthCache.getTtlForStatus(classification.status ?? "unknown"),
          httpStatus: classification.status,
          retryable: classification.retryable,
        });
        infra.circuitBreaker.recordFailure(provider, modelId);
      }
    }

    results.push({ provider: name, healthy, unhealthy, disabledModels });
  }

  return results;
}

export function logStartupBanner(
  state: LordProvidersState,
  infra: GatewayInfrastructure,
  configuredProviders: ProviderName[],
) {
  const enabledModels: Record<ProviderName, string[]> = {
    gemini: [],
    openrouter: [],
    openai: [],
    cloudflare: [],
  };
  const disabledModels: Record<ProviderName, string[]> = {
    gemini: [],
    openrouter: [],
    openai: [],
    cloudflare: [],
  };

  for (const provider of configuredProviders) {
    const models = PROVIDER_CONFIG[provider].models;
    const enabled: string[] = [];
    const disabled: string[] = [];
    for (const modelId of models) {
      const health = infra.healthCache.get(provider, modelId);
      const circuitOpen = infra.circuitBreaker.isOpen(provider, modelId);
      if (health && health.status !== "healthy") {
        disabled.push(modelId);
      } else if (circuitOpen) {
        disabled.push(modelId + " (open circuit)");
      } else {
        enabled.push(modelId);
      }
    }
    enabledModels[provider] = enabled;
    disabledModels[provider] = disabled;
  }

  const preferredModels: Record<string, string> = {};
  for (const mode of Object.keys(LORD_MODE_LABELS) as LordMode[]) {
    const cached = getCachedCandidate(mode);
    if (cached) {
      preferredModels[mode] = `${cached.provider}/${cached.model}`;
    }
  }

  infra.logger.startupBanner({
    configuredProviders,
    enabledModels,
    disabledModels,
    healthCacheEntries: infra.healthCache.getAll().length,
    circuitBreakerEntries: infra.circuitBreaker.getAll().length,
    preferredModels,
  });
  // Image generation runs exclusively on Cloudflare Workers AI; its health is
  // reported separately at startup by the image pipeline (see ensureImageHealth).
  infra.logger.info("lord_active_image_configuration", { imageProvider: "cloudflare" });
}

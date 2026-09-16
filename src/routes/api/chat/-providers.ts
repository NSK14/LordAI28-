import type { ProviderStatus } from "@/lib/api-error";
import type { LordProvidersState, StartupValidationResult } from "@/lib/ai-gateway.server";
import {
  getGatewayInfrastructure,
  validateProvidersAtStartup,
  getConfiguredProviders,
  logStartupBanner,
} from "@/lib/ai-gateway.server";

export function buildProviderStatuses(
  validationResults: StartupValidationResult[],
): ProviderStatus[] {
  const statuses: ProviderStatus[] = [];
  for (const result of validationResults) {
    if (result.unhealthy.length === 0) {
      statuses.push({ provider: result.provider, status: "healthy" });
    } else {
      const allInvalid = result.unhealthy.every(
        (u) => u.reason === "Provider not configured (missing API key)",
      );
      const allUnavailable = result.unhealthy.every(
        (u) => u.reason !== "Provider not configured (missing API key)",
      );
      if (allInvalid) {
        statuses.push({ provider: result.provider, status: "missing_api_key" });
      } else if (allUnavailable) {
        statuses.push({ provider: result.provider, status: "unavailable" });
      } else {
        statuses.push({ provider: result.provider, status: "unavailable" });
      }
    }
  }
  return statuses;
}

let startupValidationPromise: Promise<StartupValidationResult[]> | null = null;

// Run lightweight startup validation in the background so the first real
// request benefits from it without blocking the user. Subsequent requests
// reuse the cached result. Seed the per-mode probe cache once validation
// learns provider health, so following requests skip the pre-flight probe
// and start streaming immediately.
export async function getStartupValidation(
  state: LordProvidersState,
): Promise<StartupValidationResult[]> {
  if (!startupValidationPromise) {
    const infra = getGatewayInfrastructure();
    startupValidationPromise = validateProvidersAtStartup(state, infra).then((results) => {
      infra.logger.startupValidation(results);
      logStartupBanner(state, infra, getConfiguredProviders());
      return results;
    });
  }
  return startupValidationPromise;
}

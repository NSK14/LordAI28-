import { GATEWAY_CONFIG } from "../gateway-config";
import { createLogger, type Logger } from "../gateway-logger";
import { summarizeSecret } from "../env.server";
import { PROVIDER_CONFIG } from "../lord-config";
import { OpenRouterClientError } from "../lord-config";
import { getProviderApiKey, type ProviderName } from "./diagnostics.server";

const isProd = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Instrumented fetch wrappers (per provider)
// ---------------------------------------------------------------------------

export function mergeAbortSignals(signals: AbortSignal[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
}

export function classifyFetchError(error: unknown): {
  kind: "network" | "abort" | "timeout" | "unknown";
  name: string;
  message: string;
  stack?: string;
} {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const lower = message.toLowerCase();

  if (name === "AbortError" || lower.includes("abort") || lower.includes("aborted")) {
    return { kind: "abort", name, message, stack };
  }
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("deadline")) {
    return { kind: "timeout", name, message, stack };
  }
  if (name === "TypeError" || lower.includes("fetch failed") || lower.includes("network")) {
    return { kind: "network", name, message, stack };
  }
  return { kind: "unknown", name, message, stack };
}

// Read a header value case-insensitively from whatever shape `fetch` gives us.
export function readHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }
  const record = headers as Record<string, string>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function summarizePayload(body?: BodyInit | null): Record<string, unknown> {
  if (!body || typeof body !== "string") return { hasBody: false };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      model: parsed.model,
      stream: parsed.stream,
      messagesLength: Array.isArray(parsed.messages)
        ? (parsed.messages as unknown[]).length
        : undefined,
      temperature: parsed.temperature,
      max_tokens: parsed.max_tokens ?? parsed.max_completion_tokens,
    };
  } catch {
    return { parseError: "request body was not valid JSON" };
  }
}

// Verify the key the provider SDK actually put on the wire is byte-for-byte the
// key currently in process.env. A mismatch means the SDK captured a stale value
// (for example a provider instance built before the env was reloaded), which
// presents itself as an "invalid API key" error from a perfectly valid key.
export function verifyWireKey(
  provider: ProviderName,
  logger: Logger,
  headers: { authorization?: string; googleApiKey?: string },
): { present: boolean; matchesProcessEnv: boolean; key: ReturnType<typeof summarizeSecret> } {
  const bearer = headers.authorization?.startsWith("Bearer ")
    ? headers.authorization.slice("Bearer ".length)
    : undefined;
  const wireKey = headers.googleApiKey ?? bearer;
  const envKey = getProviderApiKey(provider);
  const envVar = PROVIDER_CONFIG[provider].apiKeyEnv;
  const matchesProcessEnv = !!wireKey && !!envKey && wireKey === envKey;

  if (wireKey && envKey && !matchesProcessEnv) {
    logger.error("ai_provider_key_mismatch", {
      provider,
      envVar,
      message: `The key sent to ${provider} differs from ${envVar} in process.env`,
      wireKey: summarizeSecret(wireKey, "wire"),
      envKey: summarizeSecret(envKey, envVar),
    });
  }

  return {
    present: !!wireKey,
    matchesProcessEnv,
    key: summarizeSecret(wireKey, envVar),
  };
}

// Create a provider-aware fetch wrapper. Logs structured events
// and throws `OpenRouterClientError` (the existing classification machinery
// understands it). The error carries the provider name so callers can record
// circuit-breaker / health state.
export function makeProviderFetch(provider: ProviderName, timeoutMs: number, logger: Logger) {
  return async function providerFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const authHeader = readHeader(init?.headers, "authorization");
    const xGoogKey = readHeader(init?.headers, "x-goog-api-key");
    const contentType = readHeader(init?.headers, "content-type");

    const keyCheck = verifyWireKey(provider, logger, {
      authorization: authHeader,
      googleApiKey: xGoogKey,
    });

    logger.debug("ai_provider_request", {
      provider,
      url,
      hasAuth: !!authHeader && authHeader.startsWith("Bearer "),
      hasGoogleKey: !!xGoogKey,
      key: isProd ? { exists: !!keyCheck.key.exists } : keyCheck.key,
      keyMatchesProcessEnv: keyCheck.matchesProcessEnv,
      contentType,
      payload: summarizePayload(init?.body as string | undefined),
    });

    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = init?.signal
      ? mergeAbortSignals([init.signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const response = await fetch(input, { ...init, signal });

      const responseHeaders: Record<string, string> = {};
      if (typeof response.headers?.entries === "function") {
        for (const [k, v] of response.headers.entries()) responseHeaders[k] = v;
      }
      const requestId = response.headers.get("x-request-id") ?? undefined;

      logger.info("ai_provider_response", {
        provider,
        url,
        status: response.status,
        statusText: response.statusText,
        requestId,
        headers: responseHeaders,
      });

      if (response.ok) {
        return response;
      }

      const bodyText = await response.text();
      logger.error("ai_provider_response_error", {
        provider,
        url,
        status: response.status,
        statusText: response.statusText,
        requestId,
        body: bodyText,
        key: isProd ? { exists: !!keyCheck.key.exists } : keyCheck.key,
        keyMatchesProcessEnv: keyCheck.matchesProcessEnv,
      });

      // Auth rejections are logged explicitly (including Gemini's 400
      // API_KEY_INVALID) so the failing key is unambiguous in the logs — with
      // the safe summary only, never the secret itself.
      if (
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 400 && isAuthFailureMessage(bodyText))
      ) {
        logger.error("ai_provider_auth_failed", {
          provider,
          envVar: PROVIDER_CONFIG[provider].apiKeyEnv,
          status: response.status,
          key: isProd ? { exists: !!keyCheck.key.exists } : keyCheck.key,
          keyMatchesProcessEnv: keyCheck.matchesProcessEnv,
          hint: `${PROVIDER_CONFIG[provider].apiKeyEnv} was rejected by ${provider}. Fallback continues with the remaining providers.`,
        });
      }

      if (response.status === 429 || response.status === 404 || response.status >= 500) {
        logger.warn("ai_provider_recoverable_response", {
          provider,
          status: response.status,
          requestId,
        });
      }

      throw new OpenRouterClientError(
        `${provider} responded with ${response.status} ${response.statusText}`,
        { kind: "api", status: response.status, body: bodyText },
      );
    } catch (error: unknown) {
      const { kind, name, message, stack } = classifyFetchError(error);
      const effectiveKind =
        error instanceof OpenRouterClientError ? (error as OpenRouterClientError).kind : kind;

      logger.error("ai_provider_network_error", {
        provider,
        url,
        kind: effectiveKind,
        name,
        message,
        stack,
      });

      if (error instanceof OpenRouterClientError) throw error;
      const structured = new OpenRouterClientError(
        `${provider} client ${effectiveKind}: ${message}`,
        { kind: effectiveKind === "unknown" ? "network" : effectiveKind },
      );
      (structured as unknown as { lordProvider?: string }).lordProvider = provider;
      throw structured;
    } finally {
      clearTimeout(timeoutTimer);
    }
  };
}

function isAuthFailureMessage(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key")
  );
}

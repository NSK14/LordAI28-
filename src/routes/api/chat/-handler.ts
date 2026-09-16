import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages } from "ai";
import { z } from "zod";
import type { UIMessage } from "ai";
import type { TokenUsageEvent } from "@/lib/token-usage-store";
import {
  streamWithFallback,
  LORD_MODELS,
  LORD_SYSTEM_PROMPT,
  classifyModelError,
  createLordProviders,
  createLordGateway,
  getConfiguredProviders,
  getProviderConfigurationDiagnostics,
  type LordModelGateway,
  type LordProvidersState,
  type LordMode,
  type ModelAttempt,
} from "@/lib/ai-gateway.server";
import type { ProviderStatus } from "@/lib/api-error";
import { apiErrorResponse, getSafeErrorMessage } from "@/lib/api-error";
import {
  createLordError,
  lordErrorResponse,
  type LordError,
  type LordErrorCode,
} from "@/lib/lord-error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { GATEWAY_CONFIG } from "@/lib/gateway-config";
import { createLogger } from "@/lib/gateway-logger";
import { requireSupabaseRequestAuth } from "@/integrations/supabase/auth-middleware";
import { AllProvidersFailedError } from "@/lib/ai-gateway.server";
import { ChatRequestSchema, sanitizeProviderMessage } from "./-schema";
import {
  CHAT_DEBUG,
  logRequest,
  logRequestError,
  logChat,
  LatencyMeasurement,
  logLatency,
  getLastUserText,
} from "./-logging";
import { resolveChatFailure, type ResolvedChatFailure } from "./-errors";
import { buildMemoryPrompt } from "./-memory";
import { buildProviderStatuses, getStartupValidation } from "./-providers";

export function createChatRoute() {
  return createFileRoute("/api/chat")({
    server: {
      middleware: [requireSupabaseRequestAuth],
      handlers: {
        POST: async ({ request, context }) => {
          const requestId = crypto.randomUUID();
          logRequest("request_start", { requestId });
          const t0 = performance.now();
          const configuredProviders = getConfiguredProviders();
          const providerDiagnostics = getProviderConfigurationDiagnostics();
          logChat("api_chat_request_start", {
            requestId,
            configuredProviders,
            providers: providerDiagnostics.map((entry) => ({
              provider: entry.provider,
              configured: entry.configured,
              envVar: entry.envVar,
              key: entry.key,
            })),
          });

          if (configuredProviders.length === 0) {
            logChat("api_chat_config_error", {
              requestId,
              missing: ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
            });
            return apiErrorResponse(
              503,
              "AI_NOT_CONFIGURED",
              "AI is not configured. Add at least one of GEMINI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY to the server environment.",
              requestId,
              { configuredProviders },
            );
          }

          let rawBody: unknown;
          try {
            rawBody = await request.json();
          } catch {
            logChat("api_chat_invalid_json", { requestId });
            return apiErrorResponse(
              400,
              "INVALID_REQUEST",
              "Request body must be valid JSON.",
              requestId,
            );
          }

          const parsed = ChatRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            logChat("api_chat_invalid_request", {
              requestId,
              issues: parsed.error.issues.map((issue) => issue.message),
            });
            return apiErrorResponse(
              400,
              "INVALID_REQUEST",
              "Please send a valid conversation with 1–100 messages.",
              requestId,
            );
          }

          const body = parsed.data;
          const mode: LordMode = body.mode ?? "balanced";
          const explicitModelId = body.modelId;
          const uiMessages = body.messages as unknown as UIMessage[];
          const authContext = context as
            { userId?: string; supabase?: SupabaseClient<Database> } | undefined;
          let memoryPrompt = "";
          const authMs = Math.round(performance.now() - t0);
          const tAfterAuth = performance.now();

          if (authContext?.userId && authContext.supabase) {
            try {
              memoryPrompt = await buildMemoryPrompt(
                authContext.supabase,
                authContext.userId,
                getLastUserText(uiMessages),
                body.context?.projectId ?? null,
              );
            } catch (err) {
              logChat("api_chat_memory_fetch_error", {
                requestId,
                error: getSafeErrorMessage(err),
              });
            }
          }
          const dbMs = Math.round(performance.now() - tAfterAuth);
          const tAfterDb = performance.now();

          const appContextPrompt = body.context
            ? `CURRENT APPLICATION CONTEXT:\n${JSON.stringify(body.context, null, 2)}`
            : "";
          const systemPrompt = [LORD_SYSTEM_PROMPT, memoryPrompt, appContextPrompt]
            .filter(Boolean)
            .join("\n\n");

          logChat("api_chat_request_validated", {
            requestId,
            mode,
            explicitModelId: explicitModelId ?? null,
            messageCount: body.messages.length,
            lastUserPreview: getLastUserText(uiMessages),
          });
          logRequest("request_validated", {
            requestId,
            mode,
            explicitModelId: explicitModelId ?? null,
            messageCount: body.messages.length,
          });

          const logger = createLogger(GATEWAY_CONFIG);
          const lordState: LordProvidersState = createLordProviders(logger);
          const gateway: LordModelGateway = createLordGateway(lordState);
          const modelMessages = await convertToModelMessages(uiMessages);
          let tokenUsageEvent: TokenUsageEvent | null = null;
          const modelWaitStart = performance.now();

          getStartupValidation(lordState).catch(() => {
            // Startup validation is best-effort; never block the chat endpoint.
          });

          try {
            const { result, model, provider } = await streamWithFallback({
              gateway,
              state: lordState,
              mode,
              explicitModelId,
              system: systemPrompt,
              messages: modelMessages,
              requestId,
              maxOutputTokens: 1024,
              timeoutMs: GATEWAY_CONFIG.providerTimeoutDefaultMs,
              abortSignal: request.signal,
              onTokenUsage: (event) => {
                tokenUsageEvent = event;
              },
            });

            const modelWaitMs = Math.round(performance.now() - modelWaitStart);
            const ttftMs = (result as unknown as { ttftMs?: number }).ttftMs ?? 0;
            const streamMs = (result as unknown as { streamMs?: number }).streamMs ?? 0;
            const totalMs = Math.round(performance.now() - t0);

            logLatency({
              event: "ai_latency",
              requestId,
              provider,
              model,
              authMs,
              dbMs,
              modelWaitMs,
              ttftMs,
              streamMs,
              totalMs,
            });

            const response = result.toUIMessageStreamResponse({
              headers: {
                "Cache-Control": "no-store",
                "X-LordAI-Request-Id": requestId,
                "X-LordAI-Model": model,
                "X-LordAI-Provider": provider,
              },
              // Surface the REAL reason to the client instead of the SDK default
              // "An error occurred." (Phase 5 / Phase 11). The message is a
              // JSON-encoded `LordError` the frontend re-parses into an actionable
              // card. Stream-level errors are always retryable-driven: client
              // cancellation / abort is reported as recoverable so Retry is safe.
              onError: (error: unknown) => {
                const classification = classifyModelError(error);
                const rawMessage =
                  classification.providerMessage ??
                  (error instanceof Error ? error.message : getSafeErrorMessage(error));
                const lower = rawMessage.toLowerCase();
                const name = error instanceof Error ? error.name : "";
                let code: LordErrorCode = "AI_UPSTREAM_ERROR";
                if (classification.reason === "invalid_api_key") code = "AI_AUTH_ERROR";
                else if (
                  classification.reason === "malformed_request" ||
                  classification.reason === "invalid_messages"
                )
                  code = "AI_BAD_REQUEST";
                else if (classification.reason === "insufficient_credits")
                  code = "AI_CREDITS_EXHAUSTED";
                else if (classification.reason === "rate_limit") code = "AI_RATE_LIMITED";
                else if (classification.reason === "model_unavailable")
                  code = "AI_PROVIDER_UNAVAILABLE";
                else if (
                  lower.includes("timeout") ||
                  lower.includes("timed out") ||
                  name === "TimeoutError"
                )
                  code = "AI_TIMEOUT";
                else if (lower.includes("abort") || name === "AbortError")
                  code = "AI_STREAM_INTERRUPTED";
                else if (lower.includes("network") || lower.includes("fetch failed"))
                  code = "AI_STREAM_INTERRUPTED";
                const lordErr = createLordError({
                  code,
                  provider,
                  model,
                  message: rawMessage,
                  recoverable: classification.retryable,
                  requestId,
                });
                logger.error("ai_stream_error_surfaced", {
                  requestId,
                  provider,
                  model,
                  code,
                  message: rawMessage,
                });
                return JSON.stringify(lordErr);
              },
              messageMetadata: ({ part }) => {
                if (part.type !== "finish") return undefined;
                if (tokenUsageEvent) return { tokenUsage: tokenUsageEvent };
                const usage = part.totalUsage;
                return {
                  tokenUsage: {
                    requestId,
                    model,
                    mode,
                    finishReason: part.finishReason,
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
                    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
                    totalTokens: usage.totalTokens ?? 0,
                    cost: 0,
                    timestamp: Date.now(),
                  } satisfies TokenUsageEvent,
                };
              },
            });
            logChat("chat_handler_exit", {
              requestId,
              message: "CHAT HANDLER EXIT",
              status: response.status,
            });
            return response;
          } catch (err) {
            const attempts = (err as unknown as { lordAttempts?: ModelAttempt[] })?.lordAttempts;
            const lastAttempt = attempts?.[attempts.length - 1];
            const routing = err instanceof AllProvidersFailedError ? err : null;
            logChat("api_chat_stream_failed", {
              requestId,
              mode,
              reason: lastAttempt?.reason ?? classifyModelError(err).reason,
              message: getSafeErrorMessage(err),
              configuredProviders: routing?.configuredProviders ?? configuredProviders,
              attemptedProviders: routing?.attemptedProviders,
              notAttemptedProviders: routing?.notAttemptedProviders,
              allProvidersAttempted: routing?.allProvidersAttempted,
              attempts: attempts?.map((a) => ({
                model: a.model,
                status: a.status,
                reason: a.reason,
                retryable: a.retryable,
                providerMessage: sanitizeProviderMessage(a.providerMessage),
                errorCode: a.errorCode,
                requestId: a.requestId,
              })),
            });

            const providerStatuses =
              routing?.providerStatuses ??
              (err as unknown as { providerStatuses?: ProviderStatus[] })?.providerStatuses;

            const failureProvider =
              routing?.attemptedProviders?.[routing.attemptedProviders.length - 1] ?? "unknown";
            const failureModel = lastAttempt?.model ?? "unknown";

            // Normalize every failure into a single `LordError` contract
            // (Phase 5). The frontend only ever receives this shape.
            const { code, httpStatus, message, recoverable } = resolveChatFailure({
              err,
              attempts,
              routing,
            });

            const lordError: LordError = createLordError({
              code,
              provider: failureProvider,
              model: failureModel,
              message,
              recoverable,
              requestId,
            });

            logRequestError("request_failed", {
              requestId,
              mode,
              code,
              httpStatus,
              provider: failureProvider,
              model: failureModel,
              recoverable,
              reason: lastAttempt?.reason ?? classifyModelError(err).reason,
              message,
              configuredProviders: routing?.configuredProviders ?? configuredProviders,
              attemptedProviders: routing?.attemptedProviders,
              notAttemptedProviders: routing?.notAttemptedProviders,
              allProvidersAttempted: routing?.allProvidersAttempted,
            });

            return lordErrorResponse(httpStatus, lordError, {
              attempts: attempts?.map((attempt) => ({
                provider: attempt.provider,
                model: attempt.model,
                status: attempt.status,
                reason: attempt.reason,
                retryable: attempt.retryable,
                ...(attempt.providerMessage
                  ? {
                      providerMessage: sanitizeProviderMessage(attempt.providerMessage),
                    }
                  : {}),
              })),
            });
          }
        },
      },
    },
  });
}

import type { LordErrorCode } from "@/lib/lord-error";
import { GATEWAY_CONFIG } from "@/lib/gateway-config";
import {
  classifyModelError,
  type ModelAttempt,
  AllProvidersFailedError,
} from "@/lib/ai-gateway.server";

export interface ResolvedChatFailure {
  code: LordErrorCode;
  httpStatus: number;
  message: string;
  recoverable: boolean;
}

// Normalize any thrown value from the gateway into one of the `LordError` codes
// plus an HTTP status and a user-facing message (Phases 5, 11, 12).
export function resolveChatFailure(args: {
  err: unknown;
  attempts?: ModelAttempt[];
  routing: AllProvidersFailedError | null;
}): ResolvedChatFailure {
  const { err, attempts, routing } = args;
  const authLabel = GATEWAY_CONFIG.errorReasonLabels.invalid_api_key;

  if (attempts?.some((a) => a.reason === "Insufficient credits")) {
    return {
      code: "AI_CREDITS_EXHAUSTED",
      httpStatus: 402,
      recoverable: true,
      message: "AI credits are exhausted. Add workspace credits and try again.",
    };
  }
  if (!routing && attempts?.some((a) => a.reason === "Rate limited")) {
    return {
      code: "AI_RATE_LIMITED",
      httpStatus: 429,
      recoverable: true,
      message: "AI is receiving too many requests. Please retry shortly.",
    };
  }

  const { reason } = classifyModelError(err);
  const everyAttemptWasAuthFailure =
    !!attempts && attempts.length > 0 && attempts.every((a) => a.reason === authLabel);

  if (reason === "invalid_api_key" || everyAttemptWasAuthFailure) {
    return {
      code: "AI_AUTH_ERROR",
      httpStatus: 401,
      recoverable: false,
      message: "The AI provider rejected the request. Check the server API key.",
    };
  }
  if (reason === "malformed_request" || reason === "invalid_messages") {
    return {
      code: "AI_BAD_REQUEST",
      httpStatus: 400,
      recoverable: false,
      message: "The AI request was malformed.",
    };
  }
  if (reason === "model_unavailable") {
    return {
      code: "AI_PROVIDER_UNAVAILABLE",
      httpStatus: 502,
      recoverable: true,
      message: "The selected model is unavailable. Trying a fallback model.",
    };
  }

  // Routing exhausted (or aborted before routing completed).
  const userMessage = "The AI is temporarily unavailable. Please try again in a few moments.";

  return {
    code: "AI_UPSTREAM_ERROR",
    httpStatus: 502,
    recoverable: true,
    message: userMessage,
  };
}

import type { UIMessage } from "ai";

// Verbose per-request tracing. Suppressed in production unless LORD_CHAT_DEBUG
// is set, so we never leak request previews / diagnostics into prod logs.
export const CHAT_DEBUG = process.env.LORD_CHAT_DEBUG === "true";

// ---------------------------------------------------------------------------
// Structured, request-correlated logging (Phase 2 / Phase 3).
// These run in ALL environments so every error carries a request id and the
// frontend can always correlate a failure to a backend log line. Secrets are
// never logged.
// ---------------------------------------------------------------------------

export function logRequest(event: string, payload: Record<string, unknown>) {
  console.info(JSON.stringify({ event, ...payload }));
}

export function logRequestError(event: string, payload: Record<string, unknown>) {
  console.error(JSON.stringify({ event, ...payload }));
}

export function logChat(event: string, payload: Record<string, unknown>) {
  if (!CHAT_DEBUG) return;
  console.info(JSON.stringify({ event, ...payload }));
}

export interface LatencyMeasurement {
  event: "ai_latency";
  requestId: string;
  provider?: string;
  model?: string;
  authMs: number;
  dbMs: number;
  modelWaitMs: number;
  ttftMs: number;
  streamMs: number;
  totalMs: number;
}

export function logLatency(m: LatencyMeasurement) {
  if (!CHAT_DEBUG) return;
  console.info(JSON.stringify(m));
}

// Return up to the first 120 chars of the latest user turn so request logs
// carry a non-secret preview of what was asked without ever logging full
// conversation state.
export function getLastUserText(messages: UIMessage[]) {
  return (
    messages
      .slice()
      .reverse()
      .find((message) => message.role === "user")
      ?.parts?.filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("")
      .slice(0, 120) ?? ""
  );
}

import { errorFromStatus, normalizeOpenRouterError, OpenRouterError } from "./errors";
import type { ChatMessage, OpenRouterRequest } from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterClient {
  constructor(private readonly apiKey: string) {}

  async *streamChat(
    messages: readonly ChatMessage[],
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const body: OpenRouterRequest = { model, messages, stream: true, max_tokens: 512 };
    const requestBody = JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://lordai.app",
      "X-Title": "LordAI",
    };

    console.info(
      [
        `POST ${OPENROUTER_URL}`,
        "",
        "Model:",
        model,
        "",
        "Stream:",
        String(body.stream),
        "",
        "Headers:",
        `Authorization: Bearer ${maskApiKey(this.apiKey)}`,
        `Content-Type: ${headers["Content-Type"]}`,
        `HTTP-Referer: ${headers["HTTP-Referer"]}`,
        `X-Title: ${headers["X-Title"]}`,
        "",
        "Payload:",
        JSON.stringify(body, null, 2),
      ].join("\n"),
    );

    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers,
        body: requestBody,
        signal,
      });
    } catch (error) {
      throw normalizeOpenRouterError(error);
    }

    if (!response.body) {
      await logResponse(response, "");
      throw new OpenRouterError("network");
    }

    const [streamBody, diagnosticBody] = response.body.tee();
    const diagnosticBodyPromise = readResponseBody(diagnosticBody);

    try {
      if (!response.ok) {
        const details = await diagnosticBodyPromise;
        throw errorFromStatus(response.status, details);
      }

      yield* this.readStream(streamBody);
    } catch (error) {
      throw normalizeOpenRouterError(error);
    } finally {
      await logResponse(response, await diagnosticBodyPromise);
    }
  }

  private async *readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const token = parseSseLine(line);
          if (token === null) return;
          if (token) yield token;
        }
        if (done) return;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function maskApiKey(apiKey: string): string {
  return `${apiKey.slice(0, 8)}****`;
}

async function readResponseBody(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text().catch(() => "");
}

async function logResponse(response: Response, body: string): Promise<void> {
  console.info(`HTTP ${response.status} ${response.statusText}`);
  console.info("Response headers:");
  for (const [name, value] of response.headers.entries()) {
    console.info(`${name}: ${value}`);
  }
  console.info("Response body:");
  console.log(body);
}

function parseSseLine(line: string): string | null | undefined {
  const data = line.trim();
  if (!data.startsWith("data:")) return undefined;
  const payload = data.slice(5).trim();
  if (payload === "[DONE]") return null;

  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return parsed.choices?.[0]?.delta?.content ?? "";
  } catch (error) {
    throw new OpenRouterError("unavailable", undefined, error);
  }
}
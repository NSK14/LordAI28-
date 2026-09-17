export interface AIModel {
  id: string;
  label: string;
  provider: string;
  supportsStreaming: boolean;
  supports: readonly ["chat"];
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  models?: readonly string[];
  messages: readonly ChatMessage[];
  stream: true;
  max_tokens: 512;
}

export interface ChatResponse {
  text: string;
}

export interface ModelInfo extends AIModel {
  description?: string;
}

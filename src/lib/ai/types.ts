export interface AIProvider {
  id: string;
  name: string;
}

export interface AIModel {
  id: string;
  label: string;
  provider: string;
  supportsStreaming: boolean;
  supports: readonly ["chat"];
}

export interface ChatRequest {
  messages: unknown[];
  modelId?: string;
  mode?: string;
  system?: string;
}

export interface ChatResponse {
  text: string;
  modelId?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  apiKey?: string;
}

export interface ModelInfo extends AIModel {
  description?: string;
}
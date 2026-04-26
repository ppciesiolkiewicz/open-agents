export interface LLMResponse {
  content: string;
  tokenCount?: number;
}

export interface LLMClient {
  modelName(): string;
  invoke(prompt: string): Promise<LLMResponse>;
}

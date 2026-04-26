export interface LLMResponse {
  content: string;
}

export interface LLMClient {
  modelName(): string;
  invoke(prompt: string): Promise<LLMResponse>;
}

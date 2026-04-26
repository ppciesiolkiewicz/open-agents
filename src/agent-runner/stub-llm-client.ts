import type { LLMClient, LLMResponse } from './llm-client';

// Production stub used until slice 5 replaces it with the 0G-backed client.
export class StubLLMClient implements LLMClient {
  modelName(): string {
    return 'stub';
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    const head = prompt.slice(0, 80).replace(/\s+/g, ' ');
    return {
      content: `[stub-llm] received ${prompt.length}-char prompt; would reason about: "${head}"`,
    };
  }
}

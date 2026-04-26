import type { LLMClient, LLMResponse } from './llm-client';

// Production stub used by slice 4 (no real LLM yet) and as a test seam later.
// Slice 5 introduces a real LLMClient backed by 0G via Langchain.
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

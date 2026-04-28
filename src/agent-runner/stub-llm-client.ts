import type {
  ChatMessage,
  InvokeOptions,
  LLMClient,
  LLMResponse,
  LLMTurnResult,
  ToolDefinition,
} from './llm-client';

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

  async invokeWithTools(messages: ChatMessage[], _tools: ToolDefinition[], options?: InvokeOptions): Promise<LLMTurnResult> {
    // Stub doesn't actually call tools — flatten the message history into a
    // single prompt and return canned text. Loop in AgentRunner terminates
    // immediately because no toolCalls are returned.
    const flat = messages
      .map((m) => {
        if (m.role === 'tool') return `[tool ${m.toolCallId}]: ${m.content}`;
        if (m.role === 'assistant') return `[assistant]: ${m.content}`;
        return `[${m.role}]: ${m.content}`;
      })
      .join('\n');
    const single = await this.invoke(flat);
    if (options?.onToken) {
      options.onToken(single.content);
    }
    return {
      content: single.content,
      assistantMessage: { role: 'assistant', content: single.content },
    };
  }
}

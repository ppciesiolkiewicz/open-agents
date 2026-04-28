import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LLMClient, LLMResponse, ChatMessage, LLMTurnResult, ToolCall, ToolDefinition, InvokeOptions } from '../../agent-runner/llm-client';
import type { ZeroGBroker } from '../zerog-broker/zerog-broker-factory';

const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 1_000;

function toOpenAITool(def: ToolDefinition): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: zodToJsonSchema(def.parametersSchema, { target: 'openApi3' }) as Record<string, unknown>,
    },
  };
}

function toOpenAIMessage(msg: ChatMessage): ChatCompletionMessageParam {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: msg.content };
    case 'user':
      return { role: 'user', content: msg.content };
    case 'tool':
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: msg.content,
        ...(msg.toolCalls && msg.toolCalls.length > 0
          ? {
              tool_calls: msg.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.argumentsJson },
              })),
            }
          : {}),
      };
  }
}

export interface ZeroGLLMClientOptions {
  broker: ZeroGBroker;
  providerAddress: `0x${string}`;
  serviceUrl: string;
  model: string;
  retries?: number;
}

export class ZeroGLLMClient implements LLMClient {
  private readonly broker: ZeroGBroker;
  private readonly providerAddress: `0x${string}`;
  private readonly model: string;
  private readonly retries: number;
  private readonly openai: OpenAI;

  constructor(opts: ZeroGLLMClientOptions) {
    this.broker = opts.broker;
    this.providerAddress = opts.providerAddress;
    this.model = opts.model;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.openai = new OpenAI({ baseURL: opts.serviceUrl, apiKey: 'unused-by-0g-proxy' });
  }

  modelName(): string {
    return this.model;
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.invokeOnce(prompt);
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    throw lastErr;
  }

  private async invokeOnce(prompt: string): Promise<LLMResponse> {
    const headers = (await this.broker.inference.getRequestHeaders(this.providerAddress)) as unknown as Record<string, string>;
    const completion = await this.openai.chat.completions.create(
      { messages: [{ role: 'user', content: prompt }], model: this.model },
      { headers },
    );

    const content = completion.choices[0]?.message?.content ?? '';
    const tokenCount = completion.usage?.total_tokens;

    // Best-effort settlement validation. Failure here doesn't change the
    // returned content — the call already happened — but we log it so a
    // human can investigate provider-side mismatches.
    try {
      const isValid = await this.broker.inference.processResponse(
        this.providerAddress,
        completion.id,
        content,
      );
      if (isValid !== true) {
        console.warn(`[zerog-llm] processResponse returned ${isValid}; provider settlement may have rejected or could not verify this call`);
      }
    } catch (err) {
      console.warn('[zerog-llm] processResponse threw:', (err as Error).message);
    }

    return {
      content,
      ...(tokenCount !== undefined ? { tokenCount } : {}),
    };
  }

  async invokeWithTools(messages: ChatMessage[], tools: ToolDefinition[], options?: InvokeOptions): Promise<LLMTurnResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return options?.onToken
          ? await this.invokeWithToolsStreaming(messages, tools, options.onToken)
          : await this.invokeWithToolsOnce(messages, tools);
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    throw lastErr;
  }

  private async invokeWithToolsStreaming(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: (text: string) => void,
  ): Promise<LLMTurnResult> {
    const headers = (await this.broker.inference.getRequestHeaders(this.providerAddress)) as unknown as Record<string, string>;
    const stream = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
        stream: true,
      },
      { headers },
    );

    let content = '';
    let completionId = '';
    const toolCallAccumulator = new Map<number, { id: string; name: string; argumentsJson: string }>();

    for await (const chunk of stream) {
      completionId = completionId || chunk.id;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onToken(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const acc = toolCallAccumulator.get(idx) ?? { id: '', name: '', argumentsJson: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
          toolCallAccumulator.set(idx, acc);
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccumulator.values()].filter((c) => c.id);

    // Best-effort settlement validation; mirrors the non-streaming path. Failure here
    // does not affect the returned content.
    try {
      const isValid = await this.broker.inference.processResponse(this.providerAddress, completionId, content);
      if (isValid !== true) {
        console.warn(`[zerog-llm] processResponse returned ${isValid}; provider settlement may have rejected or could not verify this call`);
      }
    } catch (err) {
      console.warn('[zerog-llm] processResponse threw:', (err as Error).message);
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      ...(content.length > 0 ? { content } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      assistantMessage,
    };
  }

  private async invokeWithToolsOnce(messages: ChatMessage[], tools: ToolDefinition[]): Promise<LLMTurnResult> {
    const headers = (await this.broker.inference.getRequestHeaders(this.providerAddress)) as unknown as Record<string, string>;
    const completion = await this.openai.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAIMessage),
        ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
      },
      { headers },
    );

    const choice = completion.choices[0];
    if (!choice) throw new Error('0G provider returned no completion choices');

    const content = choice.message.content ?? '';
    const tokenCount = completion.usage?.total_tokens;

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      }));

    // Best-effort settlement validation (slice 5 behavior preserved).
    try {
      const isValid = await this.broker.inference.processResponse(
        this.providerAddress,
        completion.id,
        content,
      );
      if (isValid !== true) {
        console.warn(`[zerog-llm] processResponse returned ${isValid}; provider settlement may have rejected or could not verify this call`);
      }
    } catch (err) {
      console.warn('[zerog-llm] processResponse threw:', (err as Error).message);
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      ...(content.length > 0 ? { content } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {}),
      assistantMessage,
    };
  }
}

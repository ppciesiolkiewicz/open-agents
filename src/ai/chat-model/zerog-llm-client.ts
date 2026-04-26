import OpenAI from 'openai';
import type { LLMClient, LLMResponse } from '../../agent-runner/llm-client';
import type { ZeroGBroker } from '../zerog-broker/zerog-broker-factory';

const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 1_000;

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
}

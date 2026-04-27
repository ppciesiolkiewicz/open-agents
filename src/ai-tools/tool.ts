import type { ZodTypeAny, z } from 'zod';
import type { AgentConfig } from '../database/types';
import type { Wallet } from '../wallet/wallet';

// Context the runner injects into each tool invocation.
export interface AgentToolContext {
  agent: AgentConfig;
  wallet: Wallet;
  tickId: string;
}

// One tool. Generic over the parsed input shape (after zod validation) and the
// raw JSON-serializable output the LLM will see as the tool message content.
export interface AgentTool<TInput extends ZodTypeAny = ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInput;
  invoke(input: z.infer<TInput>, ctx: AgentToolContext): Promise<unknown>;
}

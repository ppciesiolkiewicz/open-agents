import type { AgentConfig, AgentMemory } from '../../database/types';
import type { ChatMessage } from '../llm-client';

export interface TickStrategyContext {
  agent: AgentConfig;
  memory: AgentMemory;
  systemPrompt: string;
}

export interface TickStrategyResult {
  userMessageContent: string;
  initialMessages: ChatMessage[];
}

export interface TickStrategy {
  buildInitialMessages(ctx: TickStrategyContext): Promise<TickStrategyResult>;
}

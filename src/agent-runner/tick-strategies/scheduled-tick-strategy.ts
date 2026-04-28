import type { ChatMessage } from '../llm-client';
import type { TickStrategy, TickStrategyContext, TickStrategyResult } from './tick-strategy';

const SCHEDULED_USER_MESSAGE = 'Run one tick.';

export class ScheduledTickStrategy implements TickStrategy {
  async buildInitialMessages(ctx: TickStrategyContext): Promise<TickStrategyResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: ctx.systemPrompt },
      { role: 'user', content: SCHEDULED_USER_MESSAGE },
    ];
    return { userMessageContent: SCHEDULED_USER_MESSAGE, initialMessages: messages };
  }
}

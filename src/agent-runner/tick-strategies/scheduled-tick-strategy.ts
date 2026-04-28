import type { ChatMessage } from '../llm-client';
import type { TickStrategy, TickStrategyContext } from './tick-strategy';

export class ScheduledTickStrategy implements TickStrategy {
  async buildInitialMessages(ctx: TickStrategyContext): Promise<ChatMessage[]> {
    return [{ role: 'system', content: ctx.systemPrompt }];
  }
}

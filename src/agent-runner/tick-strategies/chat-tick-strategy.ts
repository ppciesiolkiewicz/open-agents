import type { AgentActivityLog } from '../../agent-activity-log/agent-activity-log';
import type { ChatMessage } from '../llm-client';
import { projectChatMessagesAsLLMMessages } from './chat-history-projection';
import type { TickStrategy, TickStrategyContext } from './tick-strategy';
import { AGENT_RUNNER } from '../../constants';

export class ChatTickStrategy implements TickStrategy {
  constructor(
    private readonly activityLog: AgentActivityLog,
    private readonly userMessage: string,
  ) {}

  async buildInitialMessages(ctx: TickStrategyContext): Promise<ChatMessage[]> {
    await this.activityLog.userMessage(ctx.agent.id, ctx.tickId, { content: this.userMessage });
    const entries = await this.activityLog.list(ctx.agent.id, { limit: AGENT_RUNNER.chatHistoryLimit });
    const history = projectChatMessagesAsLLMMessages(entries);
    return [
      { role: 'system', content: ctx.systemPrompt },
      ...history,
      { role: 'user', content: this.userMessage },
    ];
  }
}

import type { AgentActivityLog } from '../../agent-activity-log/agent-activity-log';
import type { ChatMessage } from '../llm-client';
import { projectChatMessagesAsLLMMessages } from './chat-history-projection';
import type { TickStrategy, TickStrategyContext, TickStrategyResult } from './tick-strategy';
import { AGENT_RUNNER } from '../../constants';

export class ChatTickStrategy implements TickStrategy {
  constructor(
    private readonly activityLog: AgentActivityLog,
    private readonly userMessage: string,
  ) {}

  async buildInitialMessages(ctx: TickStrategyContext): Promise<TickStrategyResult> {
    const entries = await this.activityLog.list(ctx.agent.id, { limit: AGENT_RUNNER.chatHistoryLimit });
    const history = projectChatMessagesAsLLMMessages(entries);
    const messages: ChatMessage[] = [
      { role: 'system', content: ctx.systemPrompt },
      ...history,
      { role: 'user', content: this.userMessage },
    ];
    return { userMessageContent: this.userMessage, initialMessages: messages };
  }
}

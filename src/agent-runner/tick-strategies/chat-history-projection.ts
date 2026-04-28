import type { AgentActivityLogEntry } from '../../agent-activity-log/types';
import type { ChatMessage, ToolCall } from '../llm-client';

export interface ChatMessageView {
  tickId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; argumentsJson: string }[];
  toolCallId?: string;
  createdAt: number;
}

export function projectChatMessages(entries: AgentActivityLogEntry[]): ChatMessageView[] {
  const out: ChatMessageView[] = [];
  for (const e of entries) {
    if (e.type === 'user_message') {
      const p = e.payload as { content: string };
      out.push({ tickId: e.tickId, seq: e.seq, role: 'user', content: p.content, createdAt: e.timestamp });
    } else if (e.type === 'llm_response') {
      const p = e.payload as { content: string; toolCalls?: { id: string; name: string; argumentsJson: string }[] };
      const view: ChatMessageView = { tickId: e.tickId, seq: e.seq, role: 'assistant', content: p.content, createdAt: e.timestamp };
      if (p.toolCalls && p.toolCalls.length > 0) {
        view.toolCalls = p.toolCalls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.argumentsJson }));
      }
      out.push(view);
    } else if (e.type === 'tool_result') {
      const p = e.payload as { id: string; tool: string; output: unknown };
      out.push({
        tickId: e.tickId,
        seq: e.seq,
        role: 'tool',
        toolCallId: p.id,
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
        createdAt: e.timestamp,
      });
    }
  }
  return out;
}

export function projectChatMessagesAsLLMMessages(entries: AgentActivityLogEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.type === 'user_message') {
      const p = e.payload as { content: string };
      out.push({ role: 'user', content: p.content });
    } else if (e.type === 'llm_response') {
      const p = e.payload as { content: string; toolCalls?: { id: string; name: string; argumentsJson: string }[] };
      const toolCalls: ToolCall[] | undefined = p.toolCalls && p.toolCalls.length > 0
        ? p.toolCalls.map((c) => ({ id: c.id, name: c.name, argumentsJson: c.argumentsJson }))
        : undefined;
      out.push(toolCalls ? { role: 'assistant', content: p.content, toolCalls } : { role: 'assistant', content: p.content });
    } else if (e.type === 'tool_result') {
      const p = e.payload as { id: string; output: unknown };
      out.push({
        role: 'tool',
        toolCallId: p.id,
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
      });
    }
  }
  return out;
}

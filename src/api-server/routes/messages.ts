import { Router } from 'express';
import type { AgentActivityLog } from '../../agent-activity-log/agent-activity-log';
import type { AgentRunner } from '../../agent-runner/agent-runner';
import { ChatTickStrategy } from '../../agent-runner/tick-strategies/chat-tick-strategy';
import {
  projectChatMessages,
  type ChatMessageView,
} from '../../agent-runner/tick-strategies/chat-history-projection';
import type { Database } from '../../database/database';
import { assertAgentOwnedBy } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import { PaginationQuerySchema, PostMessageBodySchema } from '../openapi/schemas';
import { SseWriter } from '../sse/event-stream';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
}

export function buildMessagesRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'chat') {
        throw new BadRequestError('unsupported_for_agent_type', 'messages are chat-only');
      }

      const q = PaginationQuerySchema.parse(req.query);
      const entries = await deps.activityLog.list(agentId);
      let views: ChatMessageView[] = projectChatMessages(entries);

      if (q.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(q.cursor);
        } catch {
          throw new BadRequestError('invalid_cursor');
        }
        if (q.order === 'desc') {
          views = views.filter(
            (v) =>
              v.createdAt < cursor.createdAt ||
              (v.createdAt === cursor.createdAt && viewId(v) < cursor.id),
          );
        } else {
          views = views.filter(
            (v) =>
              v.createdAt > cursor.createdAt ||
              (v.createdAt === cursor.createdAt && viewId(v) > cursor.id),
          );
        }
      }

      if (q.order === 'desc') views = [...views].reverse();

      const items = views.slice(0, q.limit);
      const last = items[items.length - 1];
      const nextCursor =
        items.length === q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: viewId(last) })
          : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    let sse: SseWriter | null = null;
    try {
      const agentId = (req.params as { id: string }).id;
      const body = PostMessageBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(agentId);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'chat') {
        throw new BadRequestError('unsupported_for_agent_type', 'messages are chat-only');
      }

      sse = new SseWriter(res);

      const strategy = new ChatTickStrategy(deps.activityLog, body.content);
      let assistantContent = '';
      try {
        await deps.runner.run(agent, strategy, {
          onToken: (text) => {
            assistantContent += text;
            sse!.send({ type: 'token', text });
          },
          onToolCall: (call) => {
            sse!.send({ type: 'tool_call', id: call.id, name: call.name });
          },
          onToolResult: (result) => {
            sse!.send({ type: 'tool_result', id: result.id, name: result.name, durationMs: result.durationMs });
          },
        });
        const recent = await deps.activityLog.list(agentId);
        const finalLlmResponse = [...recent].reverse().find((e) => e.type === 'llm_response');
        const tickId = finalLlmResponse?.tickId ?? '';
        const view: ChatMessageView = {
          tickId,
          seq: finalLlmResponse?.seq ?? 0,
          role: 'assistant',
          content: assistantContent,
          createdAt: finalLlmResponse?.timestamp ?? Date.now(),
        };
        sse!.send({ type: 'done', message: view });
      } catch (err) {
        sse!.send({ type: 'error', message: (err as Error).message });
      } finally {
        sse!.close();
      }
    } catch (err) {
      if (sse && !sse.isClosed()) {
        sse.send({ type: 'error', message: (err as Error).message });
        sse.close();
        return;
      }
      next(err);
    }
  });

  return r;
}

function viewId(v: ChatMessageView): string {
  return String(v.seq);
}

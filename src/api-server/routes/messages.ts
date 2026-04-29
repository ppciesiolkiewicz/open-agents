import { Router } from 'express';
import type { AgentActivityLog } from '../../database/agent-activity-log';
import type { AgentRunner } from '../../agent-runner/agent-runner';
import { ChatTickStrategy } from '../../agent-runner/tick-strategies/chat-tick-strategy';
import {
  projectChatMessages,
  type ChatMessageView,
} from '../../agent-runner/tick-strategies/chat-history-projection';
import type { TickQueue } from '../../agent-runner/tick-queue';
import type { Database } from '../../database/database';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import { PaginationQuerySchema, PostMessageBodySchema } from '../openapi/schemas';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
  queue: TickQueue;
}

export function buildMessagesRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

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
    try {
      const agentId = (req.params as { id: string }).id;
      const body = PostMessageBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(agentId);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

      const result = await deps.queue.enqueue({
        agentId,
        trigger: 'chat',
        run: async () => {
          const strategy = new ChatTickStrategy(deps.activityLog, body.content);
          await deps.runner.run(agent, strategy, {
            onToken: (text) => deps.activityLog.emitEphemeral(agentId, { type: 'token', text }),
          });
        },
      });
      res.status(202).json({ position: result.position });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

function viewId(v: ChatMessageView): string {
  return String(v.seq);
}

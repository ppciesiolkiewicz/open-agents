import { Router } from 'express';
import type { AgentActivityLog } from '../../database/agent-activity-log';
import type { AgentActivityLogEntry } from '../../database/types';
import type { Database } from '../../database/database';
import { assertAgentOwnedBy } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import { decodeCursor, encodeCursor } from '../pagination/cursor';
import { PaginationQuerySchema } from '../openapi/schemas';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
}

export function buildActivityRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);

      const q = PaginationQuerySchema.parse(req.query);
      let entries: AgentActivityLogEntry[] = await deps.activityLog.list(agentId);

      if (q.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(q.cursor);
        } catch {
          throw new BadRequestError('invalid_cursor');
        }
        if (q.order === 'desc') {
          entries = entries.filter(
            (e) =>
              e.timestamp < cursor.createdAt ||
              (e.timestamp === cursor.createdAt && entryId(e) < cursor.id),
          );
        } else {
          entries = entries.filter(
            (e) =>
              e.timestamp > cursor.createdAt ||
              (e.timestamp === cursor.createdAt && entryId(e) > cursor.id),
          );
        }
      }

      if (q.order === 'desc') entries = [...entries].reverse();

      const items = entries.slice(0, q.limit);
      const last = items[items.length - 1];
      const nextCursor =
        items.length === q.limit && last
          ? encodeCursor({ createdAt: last.timestamp, id: entryId(last) })
          : null;

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

function entryId(e: AgentActivityLogEntry): string {
  return String(e.seq);
}

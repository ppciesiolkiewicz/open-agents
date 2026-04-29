import { Router } from 'express';
import type { AgentActivityLog, AgentActivityEvent } from '../../database/agent-activity-log';
import type { Database } from '../../database/database';
import { NotFoundError } from '../middleware/error-handler';
import { SseWriter } from '../sse/event-stream';

interface Deps {
  db: Database;
  activityLog: AgentActivityLog;
}

export function buildStreamRouter(deps: Deps): Router {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res, next) => {
    try {
      const agentId = (req.params as { id: string }).id;
      const agent = await deps.db.agents.findById(agentId);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

      const sse = new SseWriter(res);
      const unsubscribe = deps.activityLog.on(agentId, (event: AgentActivityEvent) => {
        if (event.kind === 'append') {
          sse.send({ type: 'append', entry: event.entry });
        } else {
          sse.send({ type: 'ephemeral', payload: event.payload });
        }
      });

      req.on('close', () => {
        unsubscribe();
        sse.close();
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

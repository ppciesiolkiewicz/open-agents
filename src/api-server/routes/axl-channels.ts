import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/database';
import { NotFoundError } from '../middleware/error-handler';
import { CreateAxlChannelBodySchema } from '../openapi/schemas';

interface Deps {
  db: Database;
  clock?: () => number;
}

export function buildAxlChannelsRouter(deps: Deps): Router {
  const r = Router();
  const now = () => (deps.clock ? deps.clock() : Date.now());

  r.get('/', async (req, res, next) => {
    try {
      const channels = await deps.db.agents.listAxlChannelsByUser(req.user!.id);
      res.json(channels);
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      const body = CreateAxlChannelBodySchema.parse(req.body);
      const created = await deps.db.agents.createAxlChannel({
        id: randomUUID(),
        userId: req.user!.id,
        name: body.name,
        createdAt: now(),
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const channel = await deps.db.agents.findAxlChannelById(req.params.id);
      if (!channel || channel.userId !== req.user!.id) throw new NotFoundError();
      res.json(channel);
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      const channel = await deps.db.agents.findAxlChannelById(req.params.id);
      if (!channel || channel.userId !== req.user!.id) throw new NotFoundError();
      await deps.db.agents.deleteAxlChannel(channel.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}

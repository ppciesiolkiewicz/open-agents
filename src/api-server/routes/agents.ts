import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/database';
import type { AgentConfig } from '../../database/types';
import { NotFoundError } from '../middleware/error-handler';
import {
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
} from '../openapi/schemas';

interface Deps {
  db: Database;
  clock?: () => number;
}

export function buildAgentsRouter(deps: Deps): Router {
  const r = Router();
  const now = () => (deps.clock ? deps.clock() : Date.now());

  r.get('/', async (req, res, next) => {
    try {
      const agents = await deps.db.agents.listByUser(req.user!.id);
      res.json(agents);
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      const body = CreateAgentBodySchema.parse(req.body);
      const agent: AgentConfig = {
        id: randomUUID(),
        userId: req.user!.id,
        name: body.name,
        prompt: body.prompt,
        dryRun: body.dryRun,
        ...(body.dryRunSeedBalances ? { dryRunSeedBalances: body.dryRunSeedBalances } : {}),
        riskLimits: body.riskLimits,
        createdAt: now(),
        running: false,
        lastTickAt: null,
        ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
      };
      await deps.db.agents.upsert(agent);
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/:id', async (req, res, next) => {
    try {
      const body = UpdateAgentBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();

      const updated: AgentConfig = {
        ...agent,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.riskLimits !== undefined ? { riskLimits: body.riskLimits } : {}),
        ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
      };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      await deps.db.agents.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/start', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const updated: AgentConfig = { ...agent, running: true };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/stop', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const updated: AgentConfig = { ...agent, running: false };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

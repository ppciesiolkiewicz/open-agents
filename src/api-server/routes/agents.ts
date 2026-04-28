import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/database';
import type { AgentConfig } from '../../database/types';
import { assertAgentOwnedBy } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../middleware/error-handler';
import {
  AgentTypeSchema,
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
      const typeFilter = req.query.type
        ? AgentTypeSchema.parse(req.query.type)
        : undefined;
      let agents = await deps.db.agents.list();
      if (typeFilter) agents = agents.filter((a) => a.type === typeFilter);
      res.json(agents);
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      const body = CreateAgentBodySchema.parse(req.body);
      const base: AgentConfig = {
        id: randomUUID(),
        name: body.name,
        type: body.type,
        prompt: body.prompt,
        walletAddress: body.walletAddress,
        dryRun: body.dryRun,
        ...(body.dryRunSeedBalances ? { dryRunSeedBalances: body.dryRunSeedBalances } : {}),
        riskLimits: body.riskLimits,
        createdAt: now(),
      };
      const agent: AgentConfig =
        body.type === 'scheduled'
          ? { ...base, enabled: false, intervalMs: body.intervalMs ?? 0, lastTickAt: null }
          : { ...base, lastMessageAt: null };
      await deps.db.agents.upsert(agent);
      res.status(201).json(agent);
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  r.patch('/:id', async (req, res, next) => {
    try {
      const body = UpdateAgentBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);

      if (body.intervalMs !== undefined && agent.type !== 'scheduled') {
        throw new BadRequestError('unsupported_for_agent_type', 'intervalMs is scheduled-only');
      }

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
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      await deps.db.agents.delete(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/start', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'scheduled') {
        throw new BadRequestError('unsupported_for_agent_type', 'start is scheduled-only');
      }
      const updated: AgentConfig = { ...agent, enabled: true };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/stop', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent) throw new NotFoundError();
      assertAgentOwnedBy(agent, req.user!);
      if (agent.type !== 'scheduled') {
        throw new BadRequestError('unsupported_for_agent_type', 'stop is scheduled-only');
      }
      const updated: AgentConfig = { ...agent, enabled: false };
      await deps.db.agents.upsert(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

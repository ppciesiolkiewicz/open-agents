import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/database';
import type { AgentConfig } from '../../database/types';
import { NotFoundError } from '../middleware/error-handler';
import {
  CreateAgentBodySchema,
  ManageAgentConnectionBodySchema,
  ManageAgentChannelBodySchema,
  UpdateAgentBodySchema,
} from '../openapi/schemas';
import { UNICHAIN } from '../../constants';
import { listAllSupportedToolIds, validateAndNormalizeToolIds } from '../../ai-tools/tool-catalog';

interface Deps {
  db: Database;
  clock?: () => number;
}

export function buildAgentsRouter(deps: Deps): Router {
  const r = Router();
  const now = () => (deps.clock ? deps.clock() : Date.now());

  async function validateAndNormalizeAllowedTokens(addresses: string[]): Promise<string[]> {
    const lowered = Array.from(new Set(addresses.map((a) => a.toLowerCase())));
    if (lowered.length === 0) return [];
    const found = await deps.db.tokens.findManyByAddresses(lowered, UNICHAIN.chainId);
    const foundSet = new Set(found.map((t) => t.address));
    const unknown = lowered.filter((a) => !foundSet.has(a));
    if (unknown.length > 0) {
      const err = new Error('unknown tokens') as Error & { code?: string; unknownAddresses?: string[] };
      err.code = 'unknown_tokens';
      err.unknownAddresses = unknown;
      throw err;
    }
    return lowered;
  }

  async function sanitizeConnectedAgentIdsForUser(
    userId: string,
    agentId: string,
    requested: string[],
  ): Promise<string[]> {
    const roster = await deps.db.agents.listByUser(userId);
    const rosterIds = new Set(roster.map((a) => a.id));
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of requested) {
      if (!id || id === agentId || seen.has(id)) continue;
      if (!rosterIds.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

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
      const allowedTokens = body.allowedTokens
        ? await validateAndNormalizeAllowedTokens(body.allowedTokens)
        : [];
      const { normalizedToolIds, unknownToolIds } = validateAndNormalizeToolIds(
        body.toolIds ?? listAllSupportedToolIds(),
      );
      if (unknownToolIds.length > 0) {
        const err = new Error('unknown tool ids') as Error & { code?: string; unknownToolIds?: string[] };
        err.code = 'unknown_tool_ids';
        err.unknownToolIds = unknownToolIds;
        throw err;
      }
      const agentId = randomUUID();
      const connectedAgentIds = await sanitizeConnectedAgentIdsForUser(
        req.user!.id,
        agentId,
        body.connectedAgentIds ?? [],
      );
      const connectedChannelIds = body.connectedChannelIds ?? [];
      const agent: AgentConfig = {
        id: agentId,
        userId: req.user!.id,
        name: body.name,
        prompt: body.prompt,
        dryRun: body.dryRun,
        ...(body.dryRunSeedBalances ? { dryRunSeedBalances: body.dryRunSeedBalances } : {}),
        allowedTokens,
        toolIds: normalizedToolIds,
        connectedAgentIds: [],
        connectedChannelIds: [],
        riskLimits: body.riskLimits,
        createdAt: now(),
        running: false,
        lastTickAt: null,
        ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
      };
      await deps.db.agents.upsert(agent);
      await deps.db.agents.setAxlConnections(agent.id, connectedAgentIds);
      for (const channelId of connectedChannelIds) {
        const channel = await deps.db.agents.findAxlChannelById(channelId);
        if (!channel || channel.userId !== req.user!.id) continue;
        await deps.db.agents.addAgentToAxlChannel(agent.id, channel.id);
      }
      const created = await deps.db.agents.findById(agent.id);
      res.status(201).json(created ?? { ...agent, connectedAgentIds, connectedChannelIds });
    } catch (err) {
      if ((err as { code?: string }).code === 'unknown_tokens') {
        res.status(400).json({
          error: 'unknown_tokens',
          unknownAddresses: (err as Error & { unknownAddresses?: string[] }).unknownAddresses ?? [],
        });
        return;
      }
      if ((err as { code?: string }).code === 'unknown_tool_ids') {
        res.status(400).json({
          error: 'unknown_tool_ids',
          unknownToolIds: (err as Error & { unknownToolIds?: string[] }).unknownToolIds ?? [],
        });
        return;
      }
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

      let allowedTokensPatch: string[] | undefined;
      if (body.allowedTokens !== undefined) {
        allowedTokensPatch = await validateAndNormalizeAllowedTokens(body.allowedTokens);
      }
      let toolIdsPatch: string[] | undefined;
      if (body.toolIds !== undefined) {
        const { normalizedToolIds, unknownToolIds } = validateAndNormalizeToolIds(body.toolIds);
        if (unknownToolIds.length > 0) {
          const err = new Error('unknown tool ids') as Error & { code?: string; unknownToolIds?: string[] };
          err.code = 'unknown_tool_ids';
          err.unknownToolIds = unknownToolIds;
          throw err;
        }
        toolIdsPatch = normalizedToolIds;
      }
      let connectedAgentIdsPatch: string[] | undefined;
      if (body.connectedAgentIds !== undefined) {
        connectedAgentIdsPatch = await sanitizeConnectedAgentIdsForUser(
          req.user!.id,
          agent.id,
          body.connectedAgentIds,
        );
      }
      let connectedChannelIdsPatch: string[] | undefined;
      if (body.connectedChannelIds !== undefined) {
        const nextConnectedChannelIds: string[] = [];
        for (const channelId of body.connectedChannelIds) {
          const channel = await deps.db.agents.findAxlChannelById(channelId);
          if (!channel || channel.userId !== req.user!.id) continue;
          if (nextConnectedChannelIds.includes(channel.id)) continue;
          nextConnectedChannelIds.push(channel.id);
        }
        connectedChannelIdsPatch = nextConnectedChannelIds;
      }

      const updated: AgentConfig = {
        ...agent,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.riskLimits !== undefined ? { riskLimits: body.riskLimits } : {}),
        ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
        ...(allowedTokensPatch !== undefined ? { allowedTokens: allowedTokensPatch } : {}),
        ...(toolIdsPatch !== undefined ? { toolIds: toolIdsPatch } : {}),
      };
      await deps.db.agents.upsert(updated);
      if (connectedAgentIdsPatch !== undefined) {
        await deps.db.agents.setAxlConnections(agent.id, connectedAgentIdsPatch);
      }
      if (connectedChannelIdsPatch !== undefined) {
        const prevChannelIds = new Set(agent.connectedChannelIds ?? []);
        const nextChannelIds = new Set(connectedChannelIdsPatch);
        for (const channelId of prevChannelIds) {
          if (nextChannelIds.has(channelId)) continue;
          await deps.db.agents.removeAgentFromAxlChannel(agent.id, channelId);
        }
        for (const channelId of nextChannelIds) {
          if (prevChannelIds.has(channelId)) continue;
          await deps.db.agents.addAgentToAxlChannel(agent.id, channelId);
        }
      }
      const refreshed = await deps.db.agents.findById(agent.id);
      res.json(refreshed ?? {
        ...updated,
        connectedAgentIds: connectedAgentIdsPatch ?? updated.connectedAgentIds,
        connectedChannelIds: connectedChannelIdsPatch ?? updated.connectedChannelIds,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'unknown_tokens') {
        res.status(400).json({
          error: 'unknown_tokens',
          unknownAddresses: (err as Error & { unknownAddresses?: string[] }).unknownAddresses ?? [],
        });
        return;
      }
      if ((err as { code?: string }).code === 'unknown_tool_ids') {
        res.status(400).json({
          error: 'unknown_tool_ids',
          unknownToolIds: (err as Error & { unknownToolIds?: string[] }).unknownToolIds ?? [],
        });
        return;
      }
      next(err);
    }
  });

  r.post('/:id/connections', async (req, res, next) => {
    try {
      const body = ManageAgentConnectionBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const nextConnectedAgentIds = await sanitizeConnectedAgentIdsForUser(
        req.user!.id,
        agent.id,
        [...(agent.connectedAgentIds ?? []), body.peerAgentId],
      );
      await deps.db.agents.setAxlConnections(agent.id, nextConnectedAgentIds);
      const refreshed = await deps.db.agents.findById(agent.id);
      res.json(refreshed ?? { ...agent, connectedAgentIds: nextConnectedAgentIds });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id/connections/:peerAgentId', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const nextConnectedAgentIds = (agent.connectedAgentIds ?? []).filter(
        (id) => id !== req.params.peerAgentId,
      );
      await deps.db.agents.setAxlConnections(agent.id, nextConnectedAgentIds);
      const refreshed = await deps.db.agents.findById(agent.id);
      res.json(refreshed ?? { ...agent, connectedAgentIds: nextConnectedAgentIds });
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/channels', async (req, res, next) => {
    try {
      const body = ManageAgentChannelBodySchema.parse(req.body);
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const channel = await deps.db.agents.findAxlChannelById(body.channelId);
      if (!channel || channel.userId !== req.user!.id) throw new NotFoundError();
      await deps.db.agents.addAgentToAxlChannel(agent.id, channel.id);
      const refreshed = await deps.db.agents.findById(agent.id);
      const connectedChannelIds = Array.from(new Set([...(agent.connectedChannelIds ?? []), channel.id]));
      res.json(refreshed ?? { ...agent, connectedChannelIds });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id/channels/:channelId', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const channel = await deps.db.agents.findAxlChannelById(req.params.channelId);
      if (!channel || channel.userId !== req.user!.id) throw new NotFoundError();
      await deps.db.agents.removeAgentFromAxlChannel(agent.id, channel.id);
      const refreshed = await deps.db.agents.findById(agent.id);
      const connectedChannelIds = (agent.connectedChannelIds ?? []).filter((id) => id !== channel.id);
      res.json(refreshed ?? { ...agent, connectedChannelIds });
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

  r.get('/:id/allowed-tokens', async (req, res, next) => {
    try {
      const agent = await deps.db.agents.findById(req.params.id);
      if (!agent || agent.userId !== req.user!.id) throw new NotFoundError();
      const tokens = await deps.db.tokens.findManyByAddresses(
        agent.allowedTokens,
        UNICHAIN.chainId,
      );
      res.json({ tokens });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

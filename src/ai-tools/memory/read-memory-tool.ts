import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';

const DEFAULT_RECENT_ENTRIES = 20;

const inputSchema = z.object({
  recentEntries: z.number().int().min(0).max(200).optional()
    .describe('How many of the most-recent memory entries to return (default 20).'),
});

export function buildReadMemoryTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'readMemory',
    description:
      'Read your current persistent memory: structured state, free-form notes, and the most recent memory entries. Returns JSON {state, notes, recentEntries}.',
    inputSchema,
    async invoke({ recentEntries }, ctx) {
      const limit = recentEntries ?? DEFAULT_RECENT_ENTRIES;
      const mem = (await db.agentMemory.get(ctx.agent.id)) ?? {
        agentId: ctx.agent.id,
        notes: '',
        state: {},
        updatedAt: 0,
        entries: [],
      };
      return {
        state: mem.state,
        notes: mem.notes,
        recentEntries: mem.entries.slice(-limit),
      };
    },
  };
}

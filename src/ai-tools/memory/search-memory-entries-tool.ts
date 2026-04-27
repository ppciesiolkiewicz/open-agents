import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';

const DEFAULT_LIMIT = 10;

const inputSchema = z.object({
  query: z.string().min(1).describe('Substring to look for (case-insensitive) inside entry content.'),
  type: z.enum(['snapshot', 'observation', 'gist', 'note']).optional()
    .describe('Optional filter to one entry type.'),
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max results to return (default 10, newest first).'),
});

export function buildSearchMemoryEntriesTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'searchMemoryEntries',
    description:
      'Search your memory entries by case-insensitive substring match on content. Optional type filter. Returns the most recent matches first.',
    inputSchema,
    async invoke({ query, type, limit }, ctx) {
      const mem = await db.agentMemory.get(ctx.agent.id);
      if (!mem) return { matches: [] };
      const needle = query.toLowerCase();
      const max = limit ?? DEFAULT_LIMIT;
      const matches = mem.entries
        .filter((e) => (!type || e.type === type) && e.content.toLowerCase().includes(needle))
        .toReversed()
        .slice(0, max);
      return { matches };
    },
  };
}

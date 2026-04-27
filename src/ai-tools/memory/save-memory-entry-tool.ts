import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import type { AgentMemory, MemoryEntry, MemoryEntryType } from '../../database/types';

const inputSchema = z.object({
  type: z.enum(['snapshot', 'observation', 'gist', 'note']).describe(
    'snapshot = full state at this tick, observation = something noticed, gist = summary of other entries, note = free-form.',
  ),
  content: z.string().min(1).describe('The entry payload — free text or JSON-as-string.'),
  parentEntryIds: z.array(z.string()).optional()
    .describe('IDs of entries this gist summarizes (only relevant when type=gist).'),
});

export function buildSaveMemoryEntryTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'saveMemoryEntry',
    description:
      'Append a new entry to your memory history. Use `snapshot` to capture state at end-of-tick, `observation` for noteworthy events, `gist` to summarize earlier entries, or `note` for free-form text.',
    inputSchema,
    async invoke({ type, content, parentEntryIds }, ctx) {
      const existing: AgentMemory = (await db.agentMemory.get(ctx.agent.id)) ?? {
        agentId: ctx.agent.id,
        notes: '',
        state: {},
        updatedAt: Date.now(),
        entries: [],
      };
      const entry: MemoryEntry = {
        id: `mem-${ctx.tickId}-${existing.entries.length}`,
        tickId: ctx.tickId,
        type: type as MemoryEntryType,
        content,
        ...(parentEntryIds && parentEntryIds.length > 0 ? { parentEntryIds } : {}),
        createdAt: Date.now(),
      };
      const updated: AgentMemory = {
        ...existing,
        entries: [...existing.entries, entry],
        updatedAt: Date.now(),
      };
      await db.agentMemory.upsert(updated);
      return { ok: true, entryId: entry.id, totalEntries: updated.entries.length };
    },
  };
}

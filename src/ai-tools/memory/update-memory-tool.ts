import { z } from 'zod';
import type { AgentTool } from '../tool';
import type { Database } from '../../database/database';
import type { AgentMemory } from '../../database/types';

const inputSchema = z.object({
  state: z.record(z.unknown()).optional()
    .describe('Replacement state object. Omit to keep existing state.'),
  appendNote: z.string().optional()
    .describe('Note to append (a timestamp prefix is added).'),
});

export function buildUpdateMemoryTool(db: Database): AgentTool<typeof inputSchema> {
  return {
    name: 'updateMemory',
    description:
      'Update your persistent memory. `state` (optional) replaces the entire state object. `appendNote` (optional) appends a timestamped note. Pass either or both. Does not touch entries[]; use saveMemoryEntry for that.',
    inputSchema,
    async invoke({ state, appendNote }, ctx) {
      const existing: AgentMemory = (await db.agentMemory.get(ctx.agent.id)) ?? {
        agentId: ctx.agent.id,
        notes: '',
        state: {},
        updatedAt: Date.now(),
        entries: [],
      };
      const updatedState = state ?? existing.state;
      const updatedNotes = appendNote
        ? `${existing.notes}${existing.notes ? '\n' : ''}[${new Date().toISOString()}] ${appendNote}`
        : existing.notes;
      const updated: AgentMemory = {
        agentId: ctx.agent.id,
        state: updatedState,
        notes: updatedNotes,
        updatedAt: Date.now(),
        entries: existing.entries,
      };
      await db.agentMemory.upsert(updated);
      return { ok: true, stateKeys: Object.keys(updated.state).length, notesChars: updated.notes.length };
    },
  };
}

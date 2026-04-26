import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ActivityLogStore } from './activity-log-store';
import type { AgentActivityLogEntry } from './types';

export class FileActivityLogStore implements ActivityLogStore {
  constructor(private readonly dbDir: string) {}

  async append(entry: AgentActivityLogEntry): Promise<void> {
    const path = this.pathFor(entry.agentId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  }

  async listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(agentId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);
    let entries = lines.map((l) => JSON.parse(l) as AgentActivityLogEntry);

    if (opts?.sinceTickId) {
      // Scan backwards so we slice after the LAST entry of the anchor tick.
      // A real tick emits multiple entries sharing the same tickId
      // (tick_start, llm_call, tool_call, ..., tick_end); slicing after
      // the first would leak the anchor tick's later entries.
      // If sinceTickId is not found, return all entries (expected on first call).
      let lastIdx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.tickId === opts.sinceTickId) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) entries = entries.slice(lastIdx + 1);
    }

    if (typeof opts?.limit === 'number') {
      entries = entries.slice(-opts.limit);
    }

    return entries;
  }

  private pathFor(agentId: string): string {
    return join(this.dbDir, 'activity-log', `${agentId}.json`);
  }
}

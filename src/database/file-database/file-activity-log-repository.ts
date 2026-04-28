import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import type { AgentActivityLogEntry, AgentActivityLogEntryInput } from '../types';

export class FileActivityLogRepository implements ActivityLogRepository {
  private readonly seqByAgent = new Map<string, number>();

  constructor(private readonly dbDir: string) {}

  private async nextSeq(agentId: string): Promise<number> {
    if (!this.seqByAgent.has(agentId)) {
      try {
        const raw = await readFile(this.pathFor(agentId), 'utf8');
        const lines = raw.split('\n').filter((l) => l.length > 0);
        this.seqByAgent.set(agentId, lines.length);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.seqByAgent.set(agentId, 0);
        } else {
          throw err;
        }
      }
    }
    const cur = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, cur);
    return cur;
  }

  async append(entry: AgentActivityLogEntryInput): Promise<AgentActivityLogEntry> {
    const path = this.pathFor(entry.agentId);
    await mkdir(dirname(path), { recursive: true });
    const seq = await this.nextSeq(entry.agentId);
    const final: AgentActivityLogEntry = { ...entry, seq };
    await appendFile(path, JSON.stringify(final) + '\n', 'utf8');
    return final;
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

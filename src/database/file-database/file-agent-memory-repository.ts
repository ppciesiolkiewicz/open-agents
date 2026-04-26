import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentMemory } from '../types';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';

export class FileAgentMemoryRepository implements AgentMemoryRepository {
  constructor(private readonly dbDir: string) {}

  async get(agentId: string): Promise<AgentMemory | null> {
    try {
      const raw = await readFile(this.pathFor(agentId), 'utf8');
      return JSON.parse(raw) as AgentMemory;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async upsert(memory: AgentMemory): Promise<void> {
    const path = this.pathFor(memory.agentId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(memory, null, 2), 'utf8');
  }

  private pathFor(agentId: string): string {
    return join(this.dbDir, 'memory', `${agentId}.json`);
  }
}

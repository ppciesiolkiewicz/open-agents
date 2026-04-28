import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentConfig } from '../types';
import type { AgentRepository } from '../repositories/agent-repository';

interface DatabaseFile {
  agents: AgentConfig[];
  transactions: unknown[];   // owned by FileTransactionRepository
  positions: unknown[];      // owned by FilePositionRepository
}

export class FileAgentRepository implements AgentRepository {
  constructor(private readonly dbDir: string) {}

  async list(): Promise<AgentConfig[]> {
    const file = await this.readFile();
    return file.agents;
  }

  async findById(id: string): Promise<AgentConfig | null> {
    const file = await this.readFile();
    return file.agents.find((a) => a.id === id) ?? null;
  }

  async upsert(agent: AgentConfig): Promise<void> {
    const file = await this.readFile();
    const idx = file.agents.findIndex((a) => a.id === agent.id);
    if (idx >= 0) file.agents[idx] = agent;
    else file.agents.push(agent);
    await this.writeFile(file);
  }

  private get path(): string {
    return join(this.dbDir, 'database.json');
  }

  private async readFile(): Promise<DatabaseFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as DatabaseFile;
      parsed.agents = parsed.agents.map((a) => ({ ...a, type: a.type ?? 'scheduled' }));
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { agents: [], transactions: [], positions: [] };
      }
      throw err;
    }
  }

  private async writeFile(file: DatabaseFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), 'utf8');
  }
}

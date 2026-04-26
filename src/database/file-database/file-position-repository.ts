import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Position } from '../types';
import type { PositionRepository } from '../repositories/position-repository';

interface DatabaseFile {
  agents: unknown[];
  transactions: unknown[];
  positions: Position[];
}

export class FilePositionRepository implements PositionRepository {
  constructor(private readonly dbDir: string) {}

  async insert(pos: Position): Promise<void> {
    const file = await this.readFile();
    file.positions.push(pos);
    await this.writeFile(file);
  }

  async findOpen(agentId: string, tokenAddress: string): Promise<Position | null> {
    const file = await this.readFile();
    return (
      file.positions.find(
        (p) =>
          p.agentId === agentId &&
          p.amount.tokenAddress === tokenAddress &&
          p.closedAt === null,
      ) ?? null
    );
  }

  async listByAgent(agentId: string): Promise<Position[]> {
    const file = await this.readFile();
    return file.positions.filter((p) => p.agentId === agentId);
  }

  async update(pos: Position): Promise<void> {
    const file = await this.readFile();
    const idx = file.positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) throw new Error(`Position ${pos.id} not found`);
    file.positions[idx] = pos;
    await this.writeFile(file);
  }

  private get path(): string {
    return join(this.dbDir, 'database.json');
  }

  private async readFile(): Promise<DatabaseFile> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as DatabaseFile;
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

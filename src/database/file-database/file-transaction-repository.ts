import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Transaction } from '../types';
import type { TransactionRepository } from '../repositories/transaction-repository';

interface DatabaseFile {
  agents: unknown[];
  transactions: Transaction[];
  positions: unknown[];
}

export class FileTransactionRepository implements TransactionRepository {
  constructor(private readonly dbDir: string) {}

  async insert(tx: Transaction): Promise<void> {
    const file = await this.readFile();
    file.transactions.push(tx);
    await this.writeFile(file);
  }

  async findById(id: string): Promise<Transaction | null> {
    const file = await this.readFile();
    return file.transactions.find((t) => t.id === id) ?? null;
  }

  async listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]> {
    const file = await this.readFile();
    const all = file.transactions.filter((t) => t.agentId === agentId);
    return typeof opts?.limit === 'number' ? all.slice(-opts.limit) : all;
  }

  async updateStatus(
    id: string,
    patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>,
  ): Promise<void> {
    const file = await this.readFile();
    const idx = file.transactions.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Transaction ${id} not found`);
    const existing = file.transactions[idx]!;
    file.transactions[idx] = { ...existing, ...patch };
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

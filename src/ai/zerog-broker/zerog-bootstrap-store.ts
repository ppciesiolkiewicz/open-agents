import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZeroGBootstrapState } from './types';

export class ZeroGBootstrapStore {
  constructor(private readonly dbDir: string) {}

  async load(): Promise<ZeroGBootstrapState | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as ZeroGBootstrapState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(state: ZeroGBootstrapState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(state, null, 2), 'utf8');
  }

  private get path(): string {
    return join(this.dbDir, 'zerog-bootstrap.json');
  }
}

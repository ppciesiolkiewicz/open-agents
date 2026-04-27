import 'dotenv/config';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { confirmContinue } from '../src/test-lib/interactive-prompt';

const dbDir = process.env.DB_DIR ?? './db';

const PRESERVE_BY_DEFAULT = ['zerog-bootstrap.json'];

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');

  const entries = await listDir(dbDir);
  if (entries.length === 0) {
    console.log(`[reset-db] ${dbDir} is already empty (or missing). Nothing to do.`);
    return;
  }

  const willDelete = all ? entries : entries.filter((e) => !PRESERVE_BY_DEFAULT.includes(e));
  const willKeep = all ? [] : entries.filter((e) => PRESERVE_BY_DEFAULT.includes(e));

  if (willDelete.length === 0) {
    console.log(`[reset-db] only protected files present (${willKeep.join(', ')}). Pass --all to wipe everything.`);
    return;
  }

  console.log(`[reset-db] in ${dbDir}:`);
  console.log(`  will delete: ${willDelete.join(', ')}`);
  if (willKeep.length > 0) console.log(`  will keep:   ${willKeep.join(', ')}`);
  if (all) console.log('  --all flag set: nothing preserved (you will need to re-fund 0G to use the LLM).');

  const ok = await confirmContinue(`Proceed with reset?`);
  if (!ok) {
    console.log('[reset-db] cancelled.');
    return;
  }

  for (const name of willDelete) {
    const target = join(dbDir, name);
    const info = await stat(target);
    await rm(target, { recursive: info.isDirectory(), force: true });
    console.log(`[reset-db] removed ${target}`);
  }
  console.log('[reset-db] done.');
}

main().catch((err) => {
  console.error('[reset-db] fatal:', err);
  process.exit(1);
});

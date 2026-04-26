import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZeroGBootstrapStore } from './zerog-bootstrap-store';
import type { ZeroGBootstrapState } from './types';

const sample: ZeroGBootstrapState = {
  network: 'testnet',
  providerAddress: '0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08',
  serviceUrl: 'https://provider.example.0g.ai/v1',
  model: 'llama-3.3-70b-instruct',
  acknowledgedAt: 1_700_000_000_000,
  fundedAt: 1_700_000_500_000,
  fundAmountOG: 1,
};

describe('ZeroGBootstrapStore (live, real filesystem)', () => {
  let dbDir: string;
  let store: ZeroGBootstrapStore;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-zerog-'));
    store = new ZeroGBootstrapStore(dbDir);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns null when no bootstrap file exists', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips a full bootstrap state', async () => {
    await store.save(sample);
    const loaded = await store.load();
    console.log('[zerog-store] loaded:', loaded);
    expect(loaded).toEqual(sample);
  });

  it('overwrites a previous state on repeated save', async () => {
    await store.save(sample);
    const updated = { ...sample, fundAmountOG: 2, fundedAt: sample.fundedAt + 1 };
    await store.save(updated);
    expect(await store.load()).toEqual(updated);
  });

  it('writes JSON at db/zerog-bootstrap.json with 2-space indent', async () => {
    await store.save(sample);
    const raw = await readFile(join(dbDir, 'zerog-bootstrap.json'), 'utf8');
    expect(raw).toContain('  "network": "testnet"');  // indented two spaces
    expect(JSON.parse(raw)).toEqual(sample);
  });
});

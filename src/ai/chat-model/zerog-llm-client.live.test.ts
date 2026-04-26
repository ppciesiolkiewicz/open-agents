import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZeroGLLMClient } from './zerog-llm-client';
import { buildZeroGBroker } from '../zerog-broker/zerog-broker-factory';
import { ZeroGBootstrapStore } from '../zerog-broker/zerog-bootstrap-store';

const KEY = process.env.WALLET_PRIVATE_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);
const dbDir = process.env.DB_DIR ?? './db';
const bootstrapExists = existsSync(join(dbDir, 'zerog-bootstrap.json'));

describe.skipIf(!KEY_VALID || !bootstrapExists)('ZeroGLLMClient (live, real 0G provider)', () => {
  let client: ZeroGLLMClient;

  beforeAll(async () => {
    const store = new ZeroGBootstrapStore(dbDir);
    const state = await store.load();
    if (!state) throw new Error('bootstrap state expected (skip-guard above should have skipped)');

    const { broker } = await buildZeroGBroker({
      WALLET_PRIVATE_KEY: KEY!,
      ZEROG_NETWORK: state.network,
    });
    client = new ZeroGLLMClient({
      broker,
      providerAddress: state.providerAddress,
      serviceUrl: state.serviceUrl,
      model: state.model,
    });
  });

  it('reports the configured model name', () => {
    expect(client.modelName()).toMatch(/.+/);
    console.log('[zerog-llm] model:', client.modelName());
  });

  it('responds to a trivial prompt with a non-empty string', async () => {
    const res = await client.invoke('Reply with the single word OK and nothing else.');
    console.log('[zerog-llm] response:', res.content);
    console.log('[zerog-llm] tokens:', res.tokenCount);
    expect(typeof res.content).toBe('string');
    expect(res.content.length).toBeGreaterThan(0);
  }, 30_000);
});

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZeroGBootstrapStore } from '../zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker } from '../zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from './zerog-llm-client';

const DB_DIR = process.env.DB_DIR ?? './db';
const BOOTSTRAP_FILE = join(DB_DIR, 'zerog-bootstrap.json');

function hasBootstrapState(): boolean {
  return existsSync(BOOTSTRAP_FILE) && !!process.env.WALLET_PRIVATE_KEY;
}

describe('ZeroGLLMClient (live, requires zerog-bootstrap.json + WALLET_PRIVATE_KEY)', () => {
  it('invokeWithTools (non-streaming) returns a text response', async () => {
    if (!hasBootstrapState()) {
      console.log('[zerog-llm] skipping — no bootstrap state or WALLET_PRIVATE_KEY');
      return;
    }

    const store = new ZeroGBootstrapStore(DB_DIR);
    const state = await store.load();
    if (!state) return;

    const { broker } = await buildZeroGBroker({
      WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY!,
      ZEROG_NETWORK: state.network,
    });

    const client = new ZeroGLLMClient({
      broker,
      providerAddress: state.providerAddress,
      serviceUrl: state.serviceUrl,
      model: state.model,
    });

    const result = await client.invokeWithTools(
      [
        { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
        { role: 'user', content: 'Say "hello" in exactly one word.' },
      ],
      [],
    );

    console.log('[zerog-llm] non-streaming result:', result);
    expect(result.content).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect((result.content ?? '').length).toBeGreaterThan(0);
  });

  it('invokeWithTools (streaming) calls onToken and final content matches tokens joined', async () => {
    if (!hasBootstrapState()) {
      console.log('[zerog-llm] skipping — no bootstrap state or WALLET_PRIVATE_KEY');
      return;
    }

    const store = new ZeroGBootstrapStore(DB_DIR);
    const state = await store.load();
    if (!state) return;

    const { broker } = await buildZeroGBroker({
      WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY!,
      ZEROG_NETWORK: state.network,
    });

    const client = new ZeroGLLMClient({
      broker,
      providerAddress: state.providerAddress,
      serviceUrl: state.serviceUrl,
      model: state.model,
    });

    const tokens: string[] = [];
    const result = await client.invokeWithTools(
      [
        { role: 'system', content: 'You are a helpful assistant. Reply concisely.' },
        { role: 'user', content: 'Say "hello" in exactly one word.' },
      ],
      [],
      { onToken: (t) => tokens.push(t) },
    );

    console.log('[zerog-llm] streaming token count:', tokens.length);
    console.log('[zerog-llm] streaming final content:', result.content);
    console.log('[zerog-llm] streaming tokens joined:', tokens.join(''));

    expect(tokens.length).toBeGreaterThan(0);
    expect(result.content).toBe(tokens.join(''));
  });
});

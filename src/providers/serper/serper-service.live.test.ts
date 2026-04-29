import { describe, it, expect } from 'vitest';
import { SerperService } from './serper-service';

describe('SerperService (live)', () => {
  const svc = new SerperService({ apiKey: process.env.SERPER_API_KEY! });

  it('searches for "UNI token Uniswap"', async () => {
    const results = await svc.searchWeb('UNI token Uniswap');
    console.log('[serper] top 3 results for "UNI token Uniswap":');
    for (const r of results.slice(0, 3)) {
      console.log('  -', r.title, '→', r.link);
    }
    expect(results.length).toBeGreaterThan(0);
  });

  it('searches for "USDC stablecoin"', async () => {
    const results = await svc.searchWeb('USDC stablecoin');
    console.log('[serper] top 3 results for "USDC stablecoin":');
    for (const r of results.slice(0, 3)) {
      console.log('  -', r.title, '→', r.link);
    }
    expect(results.length).toBeGreaterThan(0);
  });
});

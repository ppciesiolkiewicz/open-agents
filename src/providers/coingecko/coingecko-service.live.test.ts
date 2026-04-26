import { describe, it, expect } from 'vitest';
import { CoingeckoService } from './coingecko-service';

const apiKey = process.env.COINGECKO_API_KEY;

describe.skipIf(!apiKey)('CoingeckoService (live, UNI/USDC)', () => {
  const svc = new CoingeckoService({ apiKey: apiKey! });

  it('fetches a UNI price', async () => {
    const price = await svc.fetchTokenPriceUSD('uniswap');
    console.log('[coingecko] UNI price USD =', price);
    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(0);
  });

  it('fetches a USDC price', async () => {
    const price = await svc.fetchTokenPriceUSD('usd-coin');
    console.log('[coingecko] USDC price USD =', price);
    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(0);
  });
});

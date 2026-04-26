import { describe, it, expect } from 'vitest';
import { CoinMarketCapService } from './coinmarketcap-service';

const apiKey = process.env.COINMARKETCAP_API_KEY;

describe.skipIf(!apiKey)('CoinMarketCapService (live, UNI/USDC)', () => {
  const svc = new CoinMarketCapService({ apiKey: apiKey! });

  it('fetches metadata for UNI', async () => {
    const info = await svc.fetchTokenInfoBySymbol('UNI');
    console.log('[cmc] UNI info:', { id: info.id, name: info.name, symbol: info.symbol, slug: info.slug });
    expect(info.symbol).toBe('UNI');
    expect(typeof info.name).toBe('string');
  });

  it('fetches metadata for USDC', async () => {
    const info = await svc.fetchTokenInfoBySymbol('USDC');
    console.log('[cmc] USDC info:', { id: info.id, name: info.name, symbol: info.symbol, slug: info.slug });
    expect(info.symbol).toBe('USDC');
  });
});

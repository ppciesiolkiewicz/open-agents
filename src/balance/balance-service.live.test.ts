import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { BalanceService } from './balance-service';

describe('BalanceService (live)', () => {
  it('fetchWalletBalances returns valid shapes for the operator wallet', async () => {
    const env = {
      ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY!,
      UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
      ZEROG_NETWORK: (process.env.ZEROG_NETWORK ?? 'testnet') as 'mainnet' | 'testnet',
      COINGECKO_API_KEY: process.env.COINGECKO_API_KEY!,
    };
    const coingecko = new CoingeckoService({ apiKey: env.COINGECKO_API_KEY });
    const svc = new BalanceService(env, coingecko);

    const address = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`).address;
    const balances = await svc.fetchWalletBalances(address);

    console.log('balances', JSON.stringify(balances, null, 2));

    expect(typeof balances.usdcOnUnichain.raw).toBe('string');
    expect(typeof balances.usdcOnUnichain.formatted).toBe('string');
    expect(typeof balances.ogOnZerog.raw).toBe('string');
    expect(typeof balances.ogOnZerog.formatted).toBe('string');
    expect(typeof balances.ogOnZerog.priceUsd).toBe('number');
    expect(balances.ogOnZerog.priceUsd).toBeGreaterThan(0);
    expect(typeof balances.ogOnZerog.valueUsd).toBe('number');
  }, 30_000);
});

import { describe, it, expect } from 'vitest';
import { loadEnv } from '../config/env.js';
import { TreasuryWallet } from './treasury-wallet.js';

describe('TreasuryWallet (live)', () => {
  const env = loadEnv();
  const wallet = new TreasuryWallet(env);

  it('returns treasury address', () => {
    const addr = wallet.getAddress();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log('treasury address:', addr);
  });

  it('reads USDC balance on Unichain', async () => {
    const balance = await wallet.getUnichainUsdcBalance();
    expect(typeof balance).toBe('bigint');
    console.log('USDC balance (raw):', balance.toString());
  });

  it('reads USDC.e balance on 0G chain', async () => {
    const balance = await wallet.getZerogUsdceBalance();
    expect(typeof balance).toBe('bigint');
    console.log('USDC.e balance on 0G (raw):', balance.toString());
  });

  it('reads native 0G balance', async () => {
    const balance = await wallet.getZerogNativeBalance();
    expect(typeof balance).toBe('bigint');
    console.log('native OG balance (raw):', balance.toString());
  });
});

import { describe, it, expect } from 'vitest';
import { RealWallet } from './real-wallet';
import { TOKENS } from '../../constants';

const KEY = process.env.WALLET_PRIVATE_KEY;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);

describe.skipIf(!KEY_VALID || !ALCHEMY)('RealWallet (live, Unichain)', () => {
  const wallet = KEY_VALID
    ? new RealWallet({
        WALLET_PRIVATE_KEY: KEY!,
        ALCHEMY_API_KEY: ALCHEMY!,
        UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
      })
    : ({} as RealWallet);

  it('derives a 0x-prefixed address from the private key', () => {
    const addr = wallet.getAddress();
    console.log('[real-wallet] address:', addr);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('reads native ETH balance on Unichain', async () => {
    const bal = await wallet.getNativeBalance();
    console.log('[real-wallet] native balance (wei):', bal.toString());
    expect(typeof bal).toBe('bigint');
    expect(bal).toBeGreaterThanOrEqual(0n);
  });

  it('reads USDC balance on Unichain', async () => {
    const bal = await wallet.getTokenBalance(TOKENS.USDC.address);
    console.log('[real-wallet] USDC balance (raw):', bal.toString());
    expect(typeof bal).toBe('bigint');
    expect(bal).toBeGreaterThanOrEqual(0n);
  });

  it('reads UNI balance on Unichain', async () => {
    const bal = await wallet.getTokenBalance(TOKENS.UNI.address);
    console.log('[real-wallet] UNI balance (raw):', bal.toString());
    expect(typeof bal).toBe('bigint');
    expect(bal).toBeGreaterThanOrEqual(0n);
  });
});

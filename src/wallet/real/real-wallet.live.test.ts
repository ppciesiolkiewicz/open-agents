import { describe, it, expect } from 'vitest';
import { RealWallet } from './real-wallet';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN } from '../../constants';

describe('RealWallet (live, Unichain)', () => {
  const wallet = new RealWallet({
    WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY!,
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });

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
    const bal = await wallet.getTokenBalance(USDC_ON_UNICHAIN.address);
    console.log('[real-wallet] USDC balance (raw):', bal.toString());
    expect(typeof bal).toBe('bigint');
    expect(bal).toBeGreaterThanOrEqual(0n);
  });

  it('reads UNI balance on Unichain', async () => {
    const bal = await wallet.getTokenBalance(UNI_ON_UNICHAIN.address);
    console.log('[real-wallet] UNI balance (raw):', bal.toString());
    expect(typeof bal).toBe('bigint');
    expect(bal).toBeGreaterThanOrEqual(0n);
  });
});

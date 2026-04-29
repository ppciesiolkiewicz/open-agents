import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { loadEnv } from '../config/env.js';
import { TreasuryWallet } from './treasury-wallet.js';
import { USDCE_ON_ZEROG, W0G_ON_ZEROG, JAINE_USDC_0G_POOL_ADDRESS } from '../constants/index.js';

describe('JaineSwapService (live, read-only)', () => {
  const env = loadEnv();
  const wallet = new TreasuryWallet(env);

  it('can read pool token0 and token1', async () => {
    const poolAbi = [
      'function token0() view returns (address)',
      'function token1() view returns (address)',
      'function fee() view returns (uint24)',
    ];
    const pool = new ethers.Contract(JAINE_USDC_0G_POOL_ADDRESS, poolAbi, wallet.zerogProvider);
    const [token0, token1, fee] = await Promise.all([pool.token0(), pool.token1(), pool.fee()]);
    expect(token0.toLowerCase()).toBe(W0G_ON_ZEROG.address.toLowerCase());
    expect(token1.toLowerCase()).toBe(USDCE_ON_ZEROG.address.toLowerCase());
    expect(Number(fee)).toBe(10000);
    console.log('pool verified: token0=W0G token1=USDC.e fee=10000');
  });

  it('reads treasury USDC.e balance on 0G', async () => {
    const balance = await wallet.getZerogUsdceBalance();
    expect(typeof balance).toBe('bigint');
    console.log('treasury USDC.e balance:', balance.toString());
  });
});

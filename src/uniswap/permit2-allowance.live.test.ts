import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { Permit2Allowance } from './permit2-allowance';
import { TOKENS } from '../constants';

const KEY = process.env.WALLET_PRIVATE_KEY;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);

describe.skipIf(!KEY_VALID || !ALCHEMY)('Permit2Allowance (live, Unichain)', () => {
  const reader = new Permit2Allowance({
    ALCHEMY_API_KEY: ALCHEMY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });
  const account = privateKeyToAccount(KEY! as `0x${string}`);

  it('reads ERC20 allowance from wallet to Permit2 (USDC)', async () => {
    const allowance = await reader.readErc20ToPermit2(TOKENS.USDC.address, account.address);
    console.log('[permit2-allowance] USDC → Permit2:', allowance.toString());
    expect(allowance).toBeGreaterThanOrEqual(0n);
  });

  it('reads Permit2 allowance to UniversalRouter (UNI)', async () => {
    const granted = await reader.readPermit2ToRouter(TOKENS.UNI.address, account.address);
    console.log('[permit2-allowance] UNI Permit2→Router:', {
      amount: granted.amount.toString(),
      expiration: granted.expiration,
      nonce: granted.nonce,
    });
    expect(granted.amount).toBeGreaterThanOrEqual(0n);
  });
});

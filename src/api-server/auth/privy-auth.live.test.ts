import { describe, it, expect } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrivyAuth } from './privy-auth';

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const TEST_TOKEN = process.env.PRIVY_TEST_TOKEN;

describe.skipIf(!APP_ID || !APP_SECRET || !TEST_TOKEN)('PrivyAuth (live)', () => {
  const auth = new PrivyAuth(new PrivyClient(APP_ID!, APP_SECRET!));

  it('verifyToken returns DID for a valid token', async () => {
    const { did } = await auth.verifyToken(TEST_TOKEN!);
    expect(did).toMatch(/^did:privy:/);
    console.log('[privy-auth] verified DID:', did);
  });

  it('verifyToken throws on a malformed token', async () => {
    await expect(auth.verifyToken('not.a.real.token')).rejects.toThrow();
  });
});

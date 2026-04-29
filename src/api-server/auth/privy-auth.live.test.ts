import { describe, it, expect } from 'vitest';
import { PrivyClient } from '@privy-io/server-auth';
import { PrivyAuth } from './privy-auth';

describe('PrivyAuth (live)', () => {
  const auth = new PrivyAuth(new PrivyClient(process.env.PRIVY_APP_ID!, process.env.PRIVY_APP_SECRET!));

  // No "valid token" test: a signed JWT requires a manual frontend login
  // flow to obtain. Verification of valid tokens is exercised end-to-end
  // through the API server when a frontend hits an authed endpoint.
  it('verifyToken throws on a malformed token', async () => {
    await expect(auth.verifyToken('not.a.real.token')).rejects.toThrow();
  });
});

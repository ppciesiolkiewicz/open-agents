import type { PrivyClient } from '@privy-io/server-auth';

export class PrivyAuth {
  constructor(private readonly client: PrivyClient) {}

  async verifyToken(bearer: string): Promise<{ did: string }> {
    const claims = await this.client.verifyAuthToken(bearer);
    return { did: claims.userId };
  }

  async getEmail(did: string): Promise<string | undefined> {
    try {
      const user = await this.client.getUser(did);
      return user.email?.address;
    } catch {
      return undefined;
    }
  }
}

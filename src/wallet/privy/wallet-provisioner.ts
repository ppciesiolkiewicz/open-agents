import { randomUUID } from "node:crypto";
import type { PrivyClient } from "@privy-io/server-auth";
import type { UserWalletRepository } from "../../database/repositories/user-wallet-repository";
import type { User, UserWallet } from "../../database/types";

interface PrivyLinkedWallet {
  type: string;
  id?: string | null;
  address?: string;
  chainType?: string;
  walletClientType?: string;
}

// =============================================================================
// TMP DEV HACK — shared dev wallet
// -----------------------------------------------------------------------------
// During early development we accumulated a pile of orphan Privy server
// wallets (created by the old code path that called walletApi.create() with no
// `owner`). They have `ownerId: null`, so getUserById(privyDid).linkedAccounts
// can't see them — every fresh DB wipe would mint yet another wallet.
//
// To stop the bleeding without manually cleaning up Privy, every user in dev
// reuses this single shared wallet: when provisionPrimary runs, we scan the
// app-wide Privy wallet list for this exact address and bind it to whatever
// User row is asking. Multiple users will share the same wallet — fine for dev,
// NOT fine for prod.
//
// Replace before shipping: either (a) point this at a fresh per-environment
// "dev wallet" address, or (b) drop the hack entirely once Privy is clean and
// every new wallet is created with `owner.userId` set (already done in
// findOrCreatePrivyServerWallet's create path).
// =============================================================================
const ALLOWED_DEV_WALLET_ADDRESS =
  "0x70b9197E72F09A13a022952F4D3DE77d99c72f2a".toLowerCase();

export class WalletProvisioner {
  constructor(
    private readonly privy: PrivyClient,
    private readonly userWallets: UserWalletRepository,
  ) {}

  async provisionPrimary(user: User): Promise<UserWallet> {
    const existing = await this.userWallets.findPrimaryByUser(user.id);
    if (existing) return existing;

    const { privyWalletId, walletAddress } =
      await this.findOrCreatePrivyServerWallet(user);

    const existingByPrivyId =
      await this.userWallets.findByPrivyWalletId(privyWalletId);
    if (existingByPrivyId) return existingByPrivyId;

    const uw: UserWallet = {
      id: randomUUID(),
      userId: user.id,
      privyWalletId,
      walletAddress,
      isPrimary: true,
      createdAt: Date.now(),
    };
    try {
      await this.userWallets.insert(uw);
      return uw;
    } catch (err) {
      const racedPrimary = await this.userWallets.findPrimaryByUser(user.id);
      if (racedPrimary) return racedPrimary;
      throw err;
    }
  }

  private async findOrCreatePrivyServerWallet(
    user: User,
  ): Promise<{ privyWalletId: string; walletAddress: string }> {
    const privyUser = await this.privy.getUserById(user.privyDid);
    const linkedWallets = (
      privyUser.linkedAccounts as PrivyLinkedWallet[]
    ).filter((a) => a.type === "wallet");

    const allAppWallets: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.privy.walletApi.getWallets(
        cursor ? { cursor, chainType: "ethereum" } : { chainType: "ethereum" },
      );
      allAppWallets.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const devWallet = (
      allAppWallets as Array<{ id: string; address: string }>
    ).find((w) => w.address?.toLowerCase() === ALLOWED_DEV_WALLET_ADDRESS);
    if (devWallet) {
      return { privyWalletId: devWallet.id, walletAddress: devWallet.address };
    }

    const created = await this.privy.walletApi.createWallet({
      chainType: "ethereum",
      owner: { userId: user.privyDid },
    });
    return { privyWalletId: created.id, walletAddress: created.address };
  }
}

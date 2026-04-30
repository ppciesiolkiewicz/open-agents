import { Router } from 'express';
import type { Database } from '../../database/database';
import type { WalletProvisioner } from '../../wallet/privy/wallet-provisioner';
import type { UserWallet } from '../../database/types';
import type { BalanceService, WalletBalances } from '../../balance/balance-service';

interface Deps {
  db: Database;
  walletProvisioner: WalletProvisioner;
  balanceService: BalanceService;
}

interface PublicWallet {
  id: string;
  walletAddress: string;
  isPrimary: boolean;
  createdAt: number;
  balances: WalletBalances | null;
}

async function buildPublicWallet(uw: UserWallet, balanceService: BalanceService): Promise<PublicWallet> {
  let balances: WalletBalances | null = null;
  try {
    balances = await balanceService.fetchWalletBalances(uw.walletAddress as `0x${string}`);
  } catch {
    // RPC or price feed unavailable — return wallet data without balances
  }
  return {
    id: uw.id,
    walletAddress: uw.walletAddress,
    isPrimary: uw.isPrimary,
    createdAt: uw.createdAt,
    balances,
  };
}

export function buildUsersRouter(deps: Deps): Router {
  const r = Router();

  r.get('/me', async (req, res, next) => {
    try {
      const user = req.user!;
      const wallets = await deps.db.userWallets.listByUser(user.id);
      const publicWallets = await Promise.all(
        wallets.map((w) => buildPublicWallet(w, deps.balanceService)),
      );
      res.json({ user, wallets: publicWallets });
    } catch (err) { next(err); }
  });

  r.post('/me/wallets', async (req, res, next) => {
    try {
      const user = req.user!;
      const existing = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (existing) {
        res.status(200).json(await buildPublicWallet(existing, deps.balanceService));
        return;
      }
      try {
        const uw = await deps.walletProvisioner.provisionPrimary(user);
        res.status(201).json(await buildPublicWallet(uw, deps.balanceService));
      } catch (err) {
        console.error('[users] wallet provisioning failed:', err);
        res.status(502).json({ error: 'wallet_provisioning_failed' });
      }
    } catch (err) { next(err); }
  });

  return r;
}

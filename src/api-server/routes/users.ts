import { Router } from 'express';
import type { Database } from '../../database/database';
import type { WalletProvisioner } from '../../wallet/privy/wallet-provisioner';
import type { UserWallet } from '../../database/types';

interface Deps {
  db: Database;
  walletProvisioner: WalletProvisioner;
}

function publicWallet(uw: UserWallet): { id: string; walletAddress: string; isPrimary: boolean; createdAt: number } {
  return {
    id: uw.id,
    walletAddress: uw.walletAddress,
    isPrimary: uw.isPrimary,
    createdAt: uw.createdAt,
  };
}

export function buildUsersRouter(deps: Deps): Router {
  const r = Router();

  r.get('/me', async (req, res, next) => {
    try {
      const user = req.user!;
      const wallets = await deps.db.userWallets.listByUser(user.id);
      res.json({ user, wallets: wallets.map(publicWallet) });
    } catch (err) { next(err); }
  });

  r.post('/me/wallets', async (req, res, next) => {
    try {
      const user = req.user!;
      const existing = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (existing) {
        res.status(200).json(publicWallet(existing));
        return;
      }
      try {
        const uw = await deps.walletProvisioner.provisionPrimary(user.id);
        res.status(201).json(publicWallet(uw));
      } catch (err) {
        console.error('[users] wallet provisioning failed:', err);
        res.status(502).json({ error: 'wallet_provisioning_failed' });
      }
    } catch (err) { next(err); }
  });

  return r;
}

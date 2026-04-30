import { Router } from 'express';
import type { Database } from '../../database/database';
import type { BalanceService } from '../../balance/balance-service';
import type { ZeroGBrokerService } from '../../ai/zerog-broker/zerog-broker-service';
import { ZeroGBalancesService } from '../../zerog/zerog-balances-service';

interface Deps {
  db: Database;
  balanceService: BalanceService;
  brokerService: ZeroGBrokerService;
}

export function buildZeroGRouter(deps: Deps): Router {
  const r = Router();

  r.get('/balances', async (req, res, next) => {
    try {
      const user = req.user!;
      const userWallet = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (!userWallet) {
        res.status(400).json({ error: 'no_wallet', message: 'Provision a wallet first via POST /users/me/wallets' });
        return;
      }

      const balancesService = new ZeroGBalancesService(deps.brokerService);
      const [balancesSnapshot, walletBalances] = await Promise.all([
        balancesService.fetchBalancesSnapshot(),
        deps.balanceService.fetchWalletBalances(userWallet.walletAddress as `0x${string}`),
      ]);

      res.json({
        providers: balancesSnapshot.providers,
        ledger: balancesSnapshot.ledger,
        onChainWalletRaw: walletBalances.ogOnZerog.raw,
        onChainWalletFormatted: walletBalances.ogOnZerog.formatted,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

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

  r.get('/providers', async (req, res, next) => {
    try {
      const listings = await deps.brokerService.listProviders();
      res.json({
        providers: listings.map((p) => ({
          providerAddress: p.providerAddress,
          serviceUrl: p.serviceUrl,
          model: p.model,
          inputPricePerToken: p.inputPricePerToken !== undefined ? String(p.inputPricePerToken) : undefined,
          outputPricePerToken: p.outputPricePerToken !== undefined ? String(p.outputPricePerToken) : undefined,
          subAccountBalanceWei: p.subAccountBalanceWei !== undefined ? String(p.subAccountBalanceWei) : undefined,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get('/balances', async (req, res, next) => {
    try {
      const user = req.user!;
      const userWallet = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (!userWallet) {
        res.status(400).json({ error: 'no_wallet', message: 'Provision a wallet first via POST /users/me/wallets' });
        return;
      }

      const wallet = userWallet.walletAddress as `0x${string}`;
      const balancesService = new ZeroGBalancesService(deps.brokerService);

      const [balancesSnapshot, walletBalances] = await Promise.all([
        balancesService.fetchBalancesSnapshot(),
        deps.balanceService.fetchWalletBalances(wallet),
      ]);

      res.json({
        providers: balancesSnapshot.providers,
        ledger: balancesSnapshot.ledger,
        onChainOG: {
          raw: walletBalances.ogOnZerog.raw,
          formatted: walletBalances.ogOnZerog.formatted,
          priceUsd: walletBalances.ogOnZerog.priceUsd,
          valueUsd: walletBalances.ogOnZerog.valueUsd,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

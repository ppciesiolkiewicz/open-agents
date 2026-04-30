import { Router } from 'express';
import type { Database } from '../../database/database';
import type { BalanceService, TokenBalanceItem, TokenForBalance } from '../../balance/balance-service';
import type { ZeroGBrokerService } from '../../ai/zerog-broker/zerog-broker-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { ZeroGBalancesService } from '../../zerog/zerog-balances-service';
import { UNICHAIN, UNICHAIN_COINGECKO_PLATFORM } from '../../constants';

interface Deps {
  db: Database;
  balanceService: BalanceService;
  brokerService: ZeroGBrokerService;
  coingecko: CoingeckoService;
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

      const wallet = userWallet.walletAddress as `0x${string}`;
      const dbTokens = await deps.db.tokens.listByChainId(UNICHAIN.chainId);
      const tokensForBalance: TokenForBalance[] = dbTokens.map((t) => ({
        address: t.address as `0x${string}`,
        symbol: t.symbol,
        decimals: t.decimals,
        chainId: t.chainId,
      }));

      const balancesService = new ZeroGBalancesService(deps.brokerService);

      const [balancesSnapshot, walletBalances, tokenBalances, tokenPrices] = await Promise.all([
        balancesService.fetchBalancesSnapshot(),
        deps.balanceService.fetchWalletBalances(wallet),
        deps.balanceService.fetchTokenBalancesOnUnichain(wallet, tokensForBalance),
        deps.coingecko.fetchTokenPricesByContract(
          UNICHAIN_COINGECKO_PLATFORM,
          tokensForBalance.map((t) => t.address),
        ),
      ]);

      const enrichedTokens = tokenBalances.map((b: TokenBalanceItem) => {
        const priceUsd = tokenPrices[b.address.toLowerCase()] ?? 0;
        const valueUsd = parseFloat(b.formatted) * priceUsd;
        return {
          chainId: b.chainId,
          address: b.address,
          symbol: b.symbol,
          decimals: b.decimals,
          balanceRaw: b.raw,
          balanceFormatted: b.formatted,
          priceUsd,
          valueUsd: Math.round(valueUsd * 1e6) / 1e6,
        };
      });

      res.json({
        providers: balancesSnapshot.providers,
        ledger: balancesSnapshot.ledger,
        onChainOG: {
          raw: walletBalances.ogOnZerog.raw,
          formatted: walletBalances.ogOnZerog.formatted,
          priceUsd: walletBalances.ogOnZerog.priceUsd,
          valueUsd: walletBalances.ogOnZerog.valueUsd,
        },
        tokens: enrichedTokens,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

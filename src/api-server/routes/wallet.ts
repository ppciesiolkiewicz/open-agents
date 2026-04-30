import { Router } from 'express';
import type { Database } from '../../database/database';
import type { BalanceService, TokenBalanceItem, TokenForBalance } from '../../balance/balance-service';
import type { CoingeckoService } from '../../providers/coingecko/coingecko-service';
import { UNICHAIN, UNICHAIN_COINGECKO_PLATFORM } from '../../constants';

interface Deps {
  db: Database;
  balanceService: BalanceService;
  coingecko: CoingeckoService;
}

interface TokenWithPrice {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
  balanceFormatted: string;
  priceUsd: number;
  valueUsd: number;
}

interface ChainBalance {
  chainId: number;
  tokens: TokenWithPrice[];
  totalValueUsd: number;
}

export function buildWalletRouter(deps: Deps): Router {
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

      const [tokenBalances, tokenPrices] = await Promise.all([
        deps.balanceService.fetchTokenBalancesOnUnichain(wallet, tokensForBalance),
        deps.coingecko.fetchTokenPricesByContract(
          UNICHAIN_COINGECKO_PLATFORM,
          tokensForBalance.map((t) => t.address),
        ),
      ]);

      const enrichedTokens: TokenWithPrice[] = tokenBalances.map((b: TokenBalanceItem) => {
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

      const unichainTotal = enrichedTokens.reduce((acc, t) => acc + t.valueUsd, 0);

      const unichain: ChainBalance = {
        chainId: UNICHAIN.chainId,
        tokens: enrichedTokens,
        totalValueUsd: Math.round(unichainTotal * 1e6) / 1e6,
      };

      const totalValueUsd = unichain.totalValueUsd;

      res.json({
        chains: { unichain },
        totalValueUsd: Math.round(totalValueUsd * 1e6) / 1e6,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

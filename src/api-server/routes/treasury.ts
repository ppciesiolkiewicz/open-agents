import { Router } from 'express';
import { z } from 'zod';
import { encodeFunctionData, erc20Abi, parseUnits } from 'viem';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Database } from '../../database/database.js';
import { TOKENS } from '../../constants/index.js';
import type { Env } from '../../config/env.js';

interface Deps {
  db: Database;
  privy: PrivyClient;
  env: Env;
  treasuryAddress: `0x${string}`;
}

const DepositBodySchema = z.object({
  amount: z.string().min(1),
});

export function buildTreasuryRouter(deps: Deps): Router {
  const r = Router();

  r.post('/deposit', async (req, res, next) => {
    try {
      const user = req.user!;
      const body = DepositBodySchema.parse(req.body);

      const userWallet = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (!userWallet) {
        res.status(400).json({ error: 'no_wallet', message: 'Provision a wallet first via POST /users/me/wallets' });
        return;
      }

      const amountRaw = parseUnits(body.amount, TOKENS.USDC.decimals);

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [deps.treasuryAddress, amountRaw],
      });

      const { hash } = await (deps.privy.walletApi as any).ethereum.sendTransaction({
        walletId: userWallet.privyWalletId,
        caip2: 'eip155:130',
        transaction: {
          to: TOKENS.USDC.address,
          data,
          chainId: 130,
        },
      });

      res.status(201).json({
        txHash: hash,
        amount: body.amount,
        symbol: TOKENS.USDC.symbol,
        decimals: TOKENS.USDC.decimals,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

import { Router } from 'express';
import { z } from 'zod';
import { encodeFunctionData, erc20Abi, parseUnits } from 'viem';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Database } from '../../database/database.js';
import type { ZeroGPurchaseStatus } from '../../database/types.js';
import { USDC_ON_UNICHAIN } from '../../constants/index.js';
import type { Env } from '../../config/env.js';

const ZEROG_PURCHASE_STATUSES: readonly ZeroGPurchaseStatus[] = [
  'pending', 'bridging', 'swapping', 'sending', 'topping_up', 'completed', 'failed',
];

const PurchasesQuerySchema = z.object({
  status: z.string().optional(),
});

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

      const amountRaw = parseUnits(body.amount, USDC_ON_UNICHAIN.decimals);

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [deps.treasuryAddress, amountRaw],
      });

      const { hash } = await (deps.privy.walletApi as any).ethereum.sendTransaction({
        walletId: userWallet.privyWalletId,
        caip2: 'eip155:130',
        transaction: {
          to: USDC_ON_UNICHAIN.address,
          data,
          chainId: 130,
        },
      });

      res.status(201).json({
        txHash: hash,
        amount: body.amount,
        symbol: USDC_ON_UNICHAIN.symbol,
        decimals: USDC_ON_UNICHAIN.decimals,
      });
    } catch (err) {
      next(err);
    }
  });

  r.get('/purchases', async (req, res, next) => {
    try {
      const user = req.user!;
      const query = PurchasesQuerySchema.parse(req.query);
      let statuses: ZeroGPurchaseStatus[] | undefined;
      if (query.status) {
        const requested = query.status.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        const invalid = requested.filter((s) => !ZEROG_PURCHASE_STATUSES.includes(s as ZeroGPurchaseStatus));
        if (invalid.length > 0) {
          res.status(400).json({
            error: 'invalid_status',
            message: `Unknown status values: ${invalid.join(', ')}. Allowed: ${ZEROG_PURCHASE_STATUSES.join(', ')}`,
          });
          return;
        }
        statuses = requested as ZeroGPurchaseStatus[];
      }
      const purchases = await deps.db.zeroGPurchases.listByUser(user.id, { statuses });
      res.json({ items: purchases });
    } catch (err) {
      next(err);
    }
  });

  r.get('/purchases/:id', async (req, res, next) => {
    try {
      const user = req.user!;
      const purchase = await deps.db.zeroGPurchases.findById(req.params.id);
      if (!purchase || purchase.userId !== user.id) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(purchase);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

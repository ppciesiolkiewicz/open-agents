import { randomBytes, randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { encodeFunctionData, erc20Abi, parseUnits } from 'viem';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Database } from '../../database/database.js';
import type { ZeroGPurchase, ZeroGPurchaseStatus } from '../../database/types.js';
import { TREASURY_SERVICE_FEE_BPS, USDC_ON_UNICHAIN } from '../../constants/index.js';
import type { Env } from '../../config/env.js';

const ZEROG_PURCHASE_STATUSES: readonly ZeroGPurchaseStatus[] = [
  'pending', 'swapping', 'sending', 'topping_up', 'completed', 'failed',
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

const FakePurchaseBodySchema = z.object({
  amount: z.string().min(1).optional(),
});

const FAKE_PURCHASE_STEP_MS = 2000;
const FAKE_PURCHASE_STATUS_SEQUENCE: ZeroGPurchaseStatus[] = [
  'swapping',
  'sending',
  'topping_up',
  'completed',
];

function fakeTxHash(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

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

  r.post('/purchases/fake', async (req, res, next) => {
    try {
      const user = req.user!;
      const body = FakePurchaseBodySchema.parse(req.body ?? {});

      const userWallet = await deps.db.userWallets.findPrimaryByUser(user.id);
      if (!userWallet) {
        res.status(400).json({ error: 'no_wallet', message: 'Provision a wallet first via POST /users/me/wallets' });
        return;
      }

      const amountStr = body.amount ?? '1';
      const incomingAmount = parseUnits(amountStr, USDC_ON_UNICHAIN.decimals);
      const serviceFeeAmount = (incomingAmount * BigInt(TREASURY_SERVICE_FEE_BPS)) / 10000n;
      const swapInputAmount = incomingAmount - serviceFeeAmount;

      const now = Date.now();
      const purchase: ZeroGPurchase = {
        id: randomUUID(),
        userId: user.id,
        userWalletAddress: userWallet.walletAddress,
        incomingTxHash: fakeTxHash(),
        incomingUsdcAmount: incomingAmount.toString(),
        serviceFeeUsdcAmount: serviceFeeAmount.toString(),
        swapInputUsdcAmount: swapInputAmount.toString(),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      await deps.db.zeroGPurchases.insert(purchase);
      console.log(`[treasury/purchases/fake] created ${purchase.id} user=${user.id} amount=${amountStr} USDC`);

      res.status(201).json(purchase);

      const advance = (i: number): void => {
        if (i >= FAKE_PURCHASE_STATUS_SEQUENCE.length) return;
        setTimeout(async () => {
          try {
            const status = FAKE_PURCHASE_STATUS_SEQUENCE[i];
            const patch: Parameters<typeof deps.db.zeroGPurchases.update>[1] = { status };
            if (status === 'swapping') {
              patch.swapTxHash = fakeTxHash();
              patch.swapInputUsdceAmount = swapInputAmount.toString();
              patch.swapOutputW0gAmount = (swapInputAmount * 1_000_000_000_000n).toString();
              patch.swapGasCostWei = '300000000000000';
              patch.unwrapTxHash = fakeTxHash();
              patch.unwrapGasCostWei = '100000000000000';
              patch.unwrappedOgAmount = (swapInputAmount * 1_000_000_000_000n).toString();
            } else if (status === 'sending') {
              patch.sendTxHash = fakeTxHash();
              patch.sendGasCostWei = '50000000000000';
              patch.ogAmountSentToUser = (swapInputAmount * 1_000_000_000_000n).toString();
            } else if (status === 'topping_up') {
              patch.ledgerTopUpTxHash = fakeTxHash();
              patch.ledgerTopUpGasCostWei = '50000000000000';
            }
            await deps.db.zeroGPurchases.update(purchase.id, patch);
            console.log(`[treasury/purchases/fake] ${purchase.id} -> ${status}`);
          } catch (err) {
            console.error(`[treasury/purchases/fake] update failed for ${purchase.id}:`, err);
          } finally {
            advance(i + 1);
          }
        }, FAKE_PURCHASE_STEP_MS);
      };
      advance(0);
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

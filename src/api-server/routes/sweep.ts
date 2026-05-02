import { Router } from 'express';
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unichain } from 'viem/chains';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Database } from '../../database/database';
import type { Env } from '../../config/env';
import {
  UNICHAIN,
  USDC_ON_UNICHAIN,
  UNI_ON_UNICHAIN,
  WBTC_ON_UNICHAIN,
  ZEROG_NETWORKS,
  ZEROG_NATIVE_TOKEN,
  resolveUnichainRpcUrl,
} from '../../constants';

interface Deps {
  db: Database;
  privy: PrivyClient;
  env: Env;
}

interface TokenSweepResult {
  symbol: string;
  chainId: number;
  raw: string;
  txHash?: string;
  error?: string;
}

interface WalletSweepResult {
  walletAddress: string;
  privyWalletId: string;
  transfers: TokenSweepResult[];
}

const UNICHAIN_ERC20S = [USDC_ON_UNICHAIN, UNI_ON_UNICHAIN, WBTC_ON_UNICHAIN] as const;
const NATIVE_TRANSFER_GAS = 21_000n;
const NATIVE_GAS_BUFFER_BPS = 12_000n;

export function buildSweepRouter(deps: Deps): Router {
  const r = Router();

  const recipient = privateKeyToAccount(deps.env.WALLET_PRIVATE_KEY as `0x${string}`).address;
  const unichainRpc = resolveUnichainRpcUrl(deps.env);
  const unichainClient = createPublicClient({ chain: unichain, transport: http(unichainRpc) }) as PublicClient;

  const zerogNet = ZEROG_NETWORKS[deps.env.ZEROG_NETWORK];
  const zerogChain = defineChain({
    id: zerogNet.chainId,
    name: `0G ${deps.env.ZEROG_NETWORK}`,
    nativeCurrency: { name: '0G', symbol: ZEROG_NATIVE_TOKEN.symbol, decimals: ZEROG_NATIVE_TOKEN.decimals },
    rpcUrls: { default: { http: [zerogNet.rpcUrl] } },
  });
  const zerogClient = createPublicClient({ chain: zerogChain, transport: http(zerogNet.rpcUrl) }) as PublicClient;

  r.get('/', async (_req, res, next) => {
    try {
      const wallets = await deps.db.userWallets.listAll();
      const results: WalletSweepResult[] = [];

      for (const w of wallets) {
        const addr = w.walletAddress as `0x${string}`;
        const transfers: TokenSweepResult[] = [];

        for (const token of UNICHAIN_ERC20S) {
          const raw = await unichainClient.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [addr],
          }) as bigint;
          if (raw === 0n) continue;
          try {
            const data = encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [recipient, raw],
            });
            const { hash } = await deps.privy.walletApi.ethereum.sendTransaction({
              walletId: w.privyWalletId,
              caip2: `eip155:${UNICHAIN.chainId}`,
              transaction: {
                to: token.address,
                data,
                chainId: UNICHAIN.chainId,
              },
            }) as { hash: string };
            await unichainClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
            transfers.push({ symbol: token.symbol, chainId: UNICHAIN.chainId, raw: raw.toString(), txHash: hash });
          } catch (err) {
            transfers.push({
              symbol: token.symbol,
              chainId: UNICHAIN.chainId,
              raw: raw.toString(),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        try {
          const balance = await zerogClient.getBalance({ address: addr });
          if (balance > 0n) {
            const gasPrice = await zerogClient.getGasPrice();
            const reserve = (NATIVE_TRANSFER_GAS * gasPrice * NATIVE_GAS_BUFFER_BPS) / 10_000n;
            if (balance > reserve) {
              const value = balance - reserve;
              try {
                const { hash } = await deps.privy.walletApi.ethereum.sendTransaction({
                  walletId: w.privyWalletId,
                  caip2: `eip155:${zerogNet.chainId}`,
                  transaction: {
                    to: recipient,
                    value: `0x${value.toString(16)}`,
                    chainId: zerogNet.chainId,
                  },
                }) as { hash: string };
                await zerogClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
                transfers.push({
                  symbol: ZEROG_NATIVE_TOKEN.symbol,
                  chainId: zerogNet.chainId,
                  raw: value.toString(),
                  txHash: hash,
                });
              } catch (err) {
                transfers.push({
                  symbol: ZEROG_NATIVE_TOKEN.symbol,
                  chainId: zerogNet.chainId,
                  raw: value.toString(),
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        } catch (err) {
          transfers.push({
            symbol: ZEROG_NATIVE_TOKEN.symbol,
            chainId: zerogNet.chainId,
            raw: '0',
            error: err instanceof Error ? err.message : String(err),
          });
        }

        results.push({ walletAddress: addr, privyWalletId: w.privyWalletId, transfers });
      }

      res.json({ recipient, walletCount: wallets.length, results });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

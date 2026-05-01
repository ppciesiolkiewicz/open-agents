import { describe, it, expect } from 'vitest';
import { createPublicClient, erc20Abi, http } from 'viem';
import type { Wallet } from '../../wallet/wallet';
import type { TxRequest } from '../../wallet/types';
import type { TransactionReceipt } from '../../wallet/types';
import type { AgentToolContext } from '../tool';
import { buildWalletBalanceTools } from './wallet-balance-tools';
import type { Database } from '../../database/database';
import type { AgentConfig } from '../../database/types';
import { resolveUnichainRpcUrl } from '../../constants';

const TARGET_WALLET = '0xc95AB88792777fFFe49fD84AD0E2fd877557bD36' as const;
const TARGET_TOKEN = '0x078D782b760474a361dDA0AF3839290b0EF57AD6' as const;

function buildDummyAgent(): AgentConfig {
  return {
    id: 'agent-for-wallet-tool-live-test',
    userId: 'user-for-wallet-tool-live-test',
    name: 'wallet-tool-live-test',
    prompt: 'test',
    dryRun: false,
    allowedTokens: [],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    createdAt: Date.now(),
    running: true,
    intervalMs: 60_000,
    lastTickAt: null,
  };
}

class WalletForSpecificAddress implements Wallet {
  private readonly client;

  constructor(
    private readonly walletAddress: `0x${string}`,
    rpcUrl: string,
  ) {
    this.client = createPublicClient({ transport: http(rpcUrl) });
  }

  getAddress(): `0x${string}` {
    return this.walletAddress;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.client.getBalance({ address: this.walletAddress });
  }

  async getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    return this.client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.walletAddress],
    });
  }

  async signAndSendTransaction(_req: TxRequest): Promise<TransactionReceipt> {
    throw new Error('not used in this test');
  }
}

describe('wallet balance ai tools (live, unichain)', () => {
  const rpcUrl = process.env.UNICHAIN_RPC_URL
    ?? (process.env.ALCHEMY_API_KEY
      ? resolveUnichainRpcUrl({ ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY })
      : undefined);

  if (!rpcUrl) {
    throw new Error('Set UNICHAIN_RPC_URL or ALCHEMY_API_KEY to run wallet-balance-tools.live.test.ts');
  }

  const db = {
    tokens: {
      async findByAddress(address: string) {
        if (address.toLowerCase() === TARGET_TOKEN.toLowerCase()) {
          return {
            id: 1,
            chainId: 130,
            chain: 'unichain',
            address: TARGET_TOKEN.toLowerCase(),
            symbol: 'USDC',
            name: 'USD Coin',
            decimals: 6,
            logoUri: null,
            coingeckoId: 'usd-coin',
          };
        }
        return null;
      },
    },
  } as unknown as Database;

  const [getWalletAddressTool, _getNativeBalanceTool, getTokenBalanceTool] = buildWalletBalanceTools(db, {
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY ?? 'unused-in-test',
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  } as any);

  it('returns the live USDC balance for the target Unichain wallet', async () => {
    const ctx: AgentToolContext = {
      agent: buildDummyAgent(),
      wallet: new WalletForSpecificAddress(TARGET_WALLET, rpcUrl),
      tickId: 'tick-wallet-balance-live-1',
    };
    const result = (await getTokenBalanceTool.invoke({ tokenAddress: TARGET_TOKEN }, ctx)) as {
      tokenAddress: string;
      raw: string;
      formatted: string;
      decimals: number;
      symbol: string;
    };
    console.log('[wallet-balance-tools.live] target wallet USDC balance:', {
      wallet: TARGET_WALLET,
      token: TARGET_TOKEN,
      result,
    });
    expect(result.tokenAddress).toBe(TARGET_TOKEN.toLowerCase());
    expect(result.symbol).toBe('USDC');
    expect(result.decimals).toBe(6);
    expect(BigInt(result.raw)).toBeGreaterThanOrEqual(0n);
  });

  it('uses ctx.wallet address, not anything from agent/db', async () => {
    const walletA = '0x1111111111111111111111111111111111111111' as const;
    const walletB = '0x2222222222222222222222222222222222222222' as const;
    const ctxA: AgentToolContext = {
      agent: buildDummyAgent(),
      wallet: new WalletForSpecificAddress(walletA, rpcUrl),
      tickId: 'tick-wallet-balance-live-2',
    };
    const ctxB: AgentToolContext = {
      agent: buildDummyAgent(),
      wallet: new WalletForSpecificAddress(walletB, rpcUrl),
      tickId: 'tick-wallet-balance-live-3',
    };
    const addrA = (await getWalletAddressTool.invoke({}, ctxA)) as { address: string };
    const addrB = (await getWalletAddressTool.invoke({}, ctxB)) as { address: string };
    expect(addrA.address).toBe(walletA);
    expect(addrB.address).toBe(walletB);
    expect(addrA.address).not.toBe(addrB.address);
  });
});

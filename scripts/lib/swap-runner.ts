import { confirmContinue } from '../../src/test-lib/interactive-prompt';
import { RealWallet } from '../../src/wallet/real/real-wallet';
import { UniswapService } from '../../src/uniswap/uniswap-service';
import { FileDatabase } from '../../src/database/file-database/file-database';
import type { TokenInfo } from '../../src/constants';
import type { AgentConfig } from '../../src/database/types';
import type { FeeTier } from '../../src/uniswap/types';

export interface RunSwapArgs {
  scenarioName: string;            // e.g. "swap-buy-uni" — used for logs + agentId
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  inputUSD: number;
  expectedOutputUSD: number;
  slippageBps: bigint;             // e.g. 200n = 2%
  feeTier?: FeeTier;
  promptText: string;
}

const dbDir = process.env.DB_DIR ?? './db';

function preflight(): { key: string; alchemy: string } {
  const key = process.env.WALLET_PRIVATE_KEY;
  const alchemy = process.env.ALCHEMY_API_KEY;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('[scripts] WALLET_PRIVATE_KEY missing or not 0x-prefixed 32-byte hex.');
    process.exit(1);
  }
  if (!alchemy) {
    console.error('[scripts] ALCHEMY_API_KEY missing.');
    process.exit(1);
  }
  return { key, alchemy };
}

export async function runSwap(args: RunSwapArgs): Promise<void> {
  const { key, alchemy } = preflight();
  const ok = await confirmContinue(args.promptText);
  if (!ok) {
    console.log(`[${args.scenarioName}] skipped by user.`);
    return;
  }

  const db = new FileDatabase(dbDir);
  const wallet = new RealWallet({
    WALLET_PRIVATE_KEY: key,
    ALCHEMY_API_KEY: alchemy,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });
  const svc = new UniswapService(
    { ALCHEMY_API_KEY: alchemy, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL },
    db,
  );
  const agent: AgentConfig = {
    id: args.scenarioName,
    name: args.scenarioName,
    running: false,
    intervalMs: 1_000,
    prompt: 'interactive script',
    walletAddress: wallet.getAddress(),
    dryRun: false,
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: Number(args.slippageBps) },
    lastTickAt: null,
    createdAt: Date.now(),
  };

  const tier: FeeTier = args.feeTier ?? 3_000;
  console.log(`[${args.scenarioName}] wallet: ${wallet.getAddress()}`);

  const inBefore = await wallet.getTokenBalance(args.tokenIn.address);
  const outBefore = await wallet.getTokenBalance(args.tokenOut.address);
  console.log(`[${args.scenarioName}] before — ${args.tokenIn.symbol}=${inBefore} ${args.tokenOut.symbol}=${outBefore}`);

  console.log(`[${args.scenarioName}] quoting…`);
  const quote = await svc.getQuoteExactIn({
    tokenIn: args.tokenIn.address,
    tokenOut: args.tokenOut.address,
    amountIn: args.amountIn,
    feeTier: tier,
  });
  const amountOutMinimum = (quote.amountOut * (10_000n - args.slippageBps)) / 10_000n;
  console.log(`[${args.scenarioName}] quote: amountOut=${quote.amountOut} amountOutMin=${amountOutMinimum}`);

  console.log(`[${args.scenarioName}] executing swap (auto-approve fires if needed)…`);
  const result = await svc.executeSwapExactIn(
    {
      tokenIn: {
        tokenAddress: args.tokenIn.address,
        symbol: args.tokenIn.symbol,
        decimals: args.tokenIn.decimals,
        amountRaw: args.amountIn.toString(),
      },
      tokenOut: {
        tokenAddress: args.tokenOut.address,
        symbol: args.tokenOut.symbol,
        decimals: args.tokenOut.decimals,
        amountRaw: quote.amountOut.toString(),
      },
      amountOutMinimum,
      feeTier: tier,
      inputUSD: args.inputUSD,
      expectedOutputUSD: args.expectedOutputUSD,
    },
    agent,
    wallet,
  );

  const inAfter = await wallet.getTokenBalance(args.tokenIn.address);
  const outAfter = await wallet.getTokenBalance(args.tokenOut.address);
  console.log(`[${args.scenarioName}] swap tx: ${result.swapTx.hash}`);
  console.log(`[${args.scenarioName}] approval txs: ${result.approvalTxs.map((t) => t.hash).join(', ') || '(none)'}`);
  console.log(`[${args.scenarioName}] ${args.tokenIn.symbol} sent: ${inBefore - inAfter}`);
  console.log(`[${args.scenarioName}] ${args.tokenOut.symbol} received: ${outAfter - outBefore}`);
  if (result.opened) {
    console.log(`[${args.scenarioName}] opened position: ${result.opened.id} costBasisUSD=${result.opened.costBasisUSD}`);
  }
  if (result.closed) {
    console.log(
      `[${args.scenarioName}] closed position: ${result.closed.id} realizedPnlUSD=${result.closed.realizedPnlUSD}`,
    );
  }
}

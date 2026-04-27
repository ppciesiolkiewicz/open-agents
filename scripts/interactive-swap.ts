import 'dotenv/config';
import { confirmContinue } from '../src/test-lib/interactive-prompt';
import { RealWallet } from '../src/wallet/real/real-wallet';
import { UniswapService } from '../src/uniswap/uniswap-service';
import { FileDatabase } from '../src/database/file-database/file-database';
import { TOKENS } from '../src/constants';
import type { AgentConfig } from '../src/database/types';

const KEY = process.env.WALLET_PRIVATE_KEY;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);

const dbDir = process.env.DB_DIR ?? './db';

const SWAP_USDC_IN = 500_000n;                  // 0.5 USDC
const SWAP_UNI_IN = 100_000_000_000_000_000n;   // 0.1 UNI
const SLIPPAGE_BPS = 200n;                       // 2%

async function preflight(): Promise<void> {
  if (!KEY_VALID) {
    console.error('[interactive] WALLET_PRIVATE_KEY is missing or not 0x-prefixed 32-byte hex.');
    process.exit(1);
  }
  if (!ALCHEMY) {
    console.error('[interactive] ALCHEMY_API_KEY is missing.');
    process.exit(1);
  }
}

async function swapUsdcForUni(): Promise<void> {
  const ok = await confirmContinue(
    `About to swap 0.5 USDC for UNI on Unichain mainnet (real funds). Continue?`,
  );
  if (!ok) {
    console.log('[interactive] USDC → UNI: skipped by user.');
    return;
  }

  const db = new FileDatabase(dbDir);
  const wallet = new RealWallet({
    WALLET_PRIVATE_KEY: KEY!,
    ALCHEMY_API_KEY: ALCHEMY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });
  const svc = new UniswapService(
    { ALCHEMY_API_KEY: ALCHEMY!, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL },
    db,
  );
  const agent: AgentConfig = {
    id: 'interactive-swap',
    name: 'Interactive Swap',
    enabled: false,
    intervalMs: 1_000,
    prompt: 'interactive',
    walletAddress: wallet.getAddress(),
    dryRun: false,
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: Date.now(),
  };

  console.log(`[interactive] wallet: ${wallet.getAddress()}`);

  const usdcBefore = await wallet.getTokenBalance(TOKENS.USDC.address);
  const uniBefore = await wallet.getTokenBalance(TOKENS.UNI.address);
  console.log(`[interactive] before — USDC=${usdcBefore} UNI=${uniBefore}`);

  console.log('[interactive] quoting…');
  const quote = await svc.getQuoteExactIn({
    tokenIn: TOKENS.USDC.address,
    tokenOut: TOKENS.UNI.address,
    amountIn: SWAP_USDC_IN,
    feeTier: 3_000,
  });
  const amountOutMinimum = (quote.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(`[interactive] quote: amountOut=${quote.amountOut} amountOutMin=${amountOutMinimum}`);

  console.log('[interactive] executing swap (auto-approve will fire if needed)…');
  const result = await svc.executeSwapExactIn(
    {
      tokenIn: {
        tokenAddress: TOKENS.USDC.address,
        symbol: TOKENS.USDC.symbol,
        decimals: TOKENS.USDC.decimals,
        amountRaw: SWAP_USDC_IN.toString(),
      },
      tokenOut: {
        tokenAddress: TOKENS.UNI.address,
        symbol: TOKENS.UNI.symbol,
        decimals: TOKENS.UNI.decimals,
        amountRaw: quote.amountOut.toString(),
      },
      amountOutMinimum,
      feeTier: 3_000,
      inputUSD: 0.5,
      expectedOutputUSD: 0.5,
    },
    agent,
    wallet,
  );

  const usdcAfter = await wallet.getTokenBalance(TOKENS.USDC.address);
  const uniAfter = await wallet.getTokenBalance(TOKENS.UNI.address);
  console.log(`[interactive] swap tx: ${result.swapTx.hash}`);
  console.log(`[interactive] approval txs: ${result.approvalTxs.map((t) => t.hash).join(', ') || '(none)'}`);
  console.log(`[interactive] USDC sent: ${usdcBefore - usdcAfter}`);
  console.log(`[interactive] UNI received: ${uniAfter - uniBefore}`);
  console.log(`[interactive] opened position: ${result.opened?.id ?? 'none'}`);
}

async function swapUniForUsdc(): Promise<void> {
  const ok = await confirmContinue(
    `About to swap 0.1 UNI for USDC on Unichain mainnet (real funds). Continue?`,
  );
  if (!ok) {
    console.log('[interactive] UNI → USDC: skipped by user.');
    return;
  }

  const db = new FileDatabase(dbDir);
  const wallet = new RealWallet({
    WALLET_PRIVATE_KEY: KEY!,
    ALCHEMY_API_KEY: ALCHEMY!,
    UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
  });
  const svc = new UniswapService(
    { ALCHEMY_API_KEY: ALCHEMY!, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL },
    db,
  );
  const agent: AgentConfig = {
    id: 'interactive-swap',
    name: 'Interactive Swap',
    enabled: false,
    intervalMs: 1_000,
    prompt: 'interactive',
    walletAddress: wallet.getAddress(),
    dryRun: false,
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
    lastTickAt: null,
    createdAt: Date.now(),
  };

  console.log(`[interactive] wallet: ${wallet.getAddress()}`);

  const usdcBefore = await wallet.getTokenBalance(TOKENS.USDC.address);
  const uniBefore = await wallet.getTokenBalance(TOKENS.UNI.address);
  console.log(`[interactive] before — USDC=${usdcBefore} UNI=${uniBefore}`);

  console.log('[interactive] quoting…');
  const quote = await svc.getQuoteExactIn({
    tokenIn: TOKENS.UNI.address,
    tokenOut: TOKENS.USDC.address,
    amountIn: SWAP_UNI_IN,
    feeTier: 3_000,
  });
  const amountOutMinimum = (quote.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(`[interactive] quote: amountOut=${quote.amountOut} amountOutMin=${amountOutMinimum}`);

  console.log('[interactive] executing swap…');
  const result = await svc.executeSwapExactIn(
    {
      tokenIn: {
        tokenAddress: TOKENS.UNI.address,
        symbol: TOKENS.UNI.symbol,
        decimals: TOKENS.UNI.decimals,
        amountRaw: SWAP_UNI_IN.toString(),
      },
      tokenOut: {
        tokenAddress: TOKENS.USDC.address,
        symbol: TOKENS.USDC.symbol,
        decimals: TOKENS.USDC.decimals,
        amountRaw: quote.amountOut.toString(),
      },
      amountOutMinimum,
      feeTier: 3_000,
      inputUSD: 0.5,
      expectedOutputUSD: 0.5,
    },
    agent,
    wallet,
  );

  const usdcAfter = await wallet.getTokenBalance(TOKENS.USDC.address);
  const uniAfter = await wallet.getTokenBalance(TOKENS.UNI.address);
  console.log(`[interactive] swap tx: ${result.swapTx.hash}`);
  console.log(`[interactive] UNI sent: ${uniBefore - uniAfter}`);
  console.log(`[interactive] USDC received: ${usdcAfter - usdcBefore}`);
  console.log(`[interactive] closed position: ${result.closed?.id ?? 'none'}, realized PnL USD: ${result.closed?.realizedPnlUSD ?? 'n/a'}`);
}

async function main(): Promise<void> {
  await preflight();
  console.log('[interactive] Two scenarios available: USDC→UNI then UNI→USDC.');
  console.log('[interactive] You will be prompted before each swap. Decline either to skip it.');

  await swapUsdcForUni();
  await swapUniForUsdc();

  console.log('[interactive] done.');
}

main().catch((err) => {
  console.error('[interactive] fatal:', err);
  process.exit(1);
});

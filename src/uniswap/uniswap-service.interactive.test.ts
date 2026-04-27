import { describe, it, expect, beforeAll } from 'vitest';
import { confirmContinue } from '../test-lib/interactive-prompt';
import { RealWallet } from '../wallet/real/real-wallet';
import { UniswapService } from './uniswap-service';
import { FileDatabase } from '../database/file-database/file-database';
import { TOKENS } from '../constants';
import type { AgentConfig } from '../database/types';

const KEY = process.env.WALLET_PRIVATE_KEY;
const ALCHEMY = process.env.ALCHEMY_API_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);
const INTERACTIVE = process.env.INTERACTIVE_TESTS === '1';

const dbDir = process.env.DB_DIR ?? './db';

// Tiny test amounts so failures are cheap.
const SWAP_USDC_IN = 500_000n;            // 0.5 USDC
const SWAP_UNI_IN  = 100_000_000_000_000_000n;   // 0.1 UNI

describe.skipIf(!INTERACTIVE || !KEY_VALID || !ALCHEMY)('UniswapService (interactive, real onchain)', () => {
  let wallet: RealWallet;
  let svc: UniswapService;
  let db: FileDatabase;
  let agent: AgentConfig;

  beforeAll(() => {
    db = new FileDatabase(dbDir);
    wallet = new RealWallet({
      WALLET_PRIVATE_KEY: KEY!,
      ALCHEMY_API_KEY: ALCHEMY!,
      UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL,
    });
    svc = new UniswapService({ ALCHEMY_API_KEY: ALCHEMY!, UNICHAIN_RPC_URL: process.env.UNICHAIN_RPC_URL }, db);
    agent = {
      id: 'interactive-swap-test',
      name: 'Interactive Swap Test',
      enabled: false,
      intervalMs: 1_000,
      prompt: 'interactive test',
      walletAddress: wallet.getAddress(),
      dryRun: false,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 200 },
      lastTickAt: null,
      createdAt: Date.now(),
    };
  });

  it('swaps 0.5 USDC for UNI on Unichain mainnet (real funds)', async (ctx) => {
    const ok = await confirmContinue(
      `About to swap 0.5 USDC for UNI on Unichain (wallet ${wallet.getAddress()}). Continue?`,
    );
    if (!ok) {
      ctx.skip();
      return;
    }

    const usdcBefore = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniBefore = await wallet.getTokenBalance(TOKENS.UNI.address);

    const quote = await svc.getQuoteExactIn({
      tokenIn: TOKENS.USDC.address,
      tokenOut: TOKENS.UNI.address,
      amountIn: SWAP_USDC_IN,
      feeTier: 3_000,
    });
    const amountOutMinimum = (quote.amountOut * 9_800n) / 10_000n;  // 2% slippage tolerance

    const result = await svc.executeSwapExactIn(
      {
        tokenIn: { tokenAddress: TOKENS.USDC.address, symbol: TOKENS.USDC.symbol, decimals: TOKENS.USDC.decimals, amountRaw: SWAP_USDC_IN.toString() },
        tokenOut: { tokenAddress: TOKENS.UNI.address, symbol: TOKENS.UNI.symbol, decimals: TOKENS.UNI.decimals, amountRaw: quote.amountOut.toString() },
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
    const usdcDelta = usdcBefore - usdcAfter;
    const uniDelta = uniAfter - uniBefore;

    console.log('[interactive] swap done. tx:', result.swapTx.hash);
    console.log('[interactive] USDC sent:', usdcDelta.toString());
    console.log('[interactive] UNI received:', uniDelta.toString());

    expect(result.swapTx.status).toBe('success');
    expect(usdcDelta).toBeGreaterThanOrEqual(SWAP_USDC_IN);
    expect(uniDelta).toBeGreaterThanOrEqual(amountOutMinimum);
    expect(result.opened).toBeDefined();
  }, 180_000);

  it('swaps 0.1 UNI for USDC on Unichain mainnet (real funds, closes the position)', async (ctx) => {
    const ok = await confirmContinue(
      `About to swap 0.1 UNI for USDC on Unichain (wallet ${wallet.getAddress()}). Continue?`,
    );
    if (!ok) {
      ctx.skip();
      return;
    }

    const usdcBefore = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniBefore = await wallet.getTokenBalance(TOKENS.UNI.address);

    const quote = await svc.getQuoteExactIn({
      tokenIn: TOKENS.UNI.address,
      tokenOut: TOKENS.USDC.address,
      amountIn: SWAP_UNI_IN,
      feeTier: 3_000,
    });
    const amountOutMinimum = (quote.amountOut * 9_800n) / 10_000n;

    const result = await svc.executeSwapExactIn(
      {
        tokenIn: { tokenAddress: TOKENS.UNI.address, symbol: TOKENS.UNI.symbol, decimals: TOKENS.UNI.decimals, amountRaw: SWAP_UNI_IN.toString() },
        tokenOut: { tokenAddress: TOKENS.USDC.address, symbol: TOKENS.USDC.symbol, decimals: TOKENS.USDC.decimals, amountRaw: quote.amountOut.toString() },
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

    console.log('[interactive] swap done. tx:', result.swapTx.hash);
    console.log('[interactive] UNI sent:', (uniBefore - uniAfter).toString());
    console.log('[interactive] USDC received:', (usdcAfter - usdcBefore).toString());

    expect(result.swapTx.status).toBe('success');
  }, 180_000);
});

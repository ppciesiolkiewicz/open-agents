import 'dotenv/config';
import { TOKENS } from '../src/constants';
import { runSwap } from './lib/swap-runner';

const AMOUNT_USDC = 500_000n;          // 0.5 USDC (6 decimals)
const INPUT_USD = 0.5;
const SLIPPAGE_BPS = 200n;             // 2%

await runSwap({
  scenarioName: 'swap-buy-uni',
  tokenIn: TOKENS.USDC,
  tokenOut: TOKENS.UNI,
  amountIn: AMOUNT_USDC,
  inputUSD: INPUT_USD,
  expectedOutputUSD: INPUT_USD,        // assume same USD value at swap time
  slippageBps: SLIPPAGE_BPS,
  promptText: `Swap 0.5 USDC for UNI on Unichain mainnet (real funds, opens a position). Continue?`,
});

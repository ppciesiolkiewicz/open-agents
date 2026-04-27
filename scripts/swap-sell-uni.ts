import 'dotenv/config';
import { TOKENS } from '../src/constants';
import { runSwap } from './lib/swap-runner';

const AMOUNT_UNI = 100_000_000_000_000_000n;   // 0.1 UNI (18 decimals)
const INPUT_USD = 0.5;                          // approx — agent risk gate uses live Coingecko anyway
const SLIPPAGE_BPS = 200n;                      // 2%

await runSwap({
  scenarioName: 'swap-sell-uni',
  tokenIn: TOKENS.UNI,
  tokenOut: TOKENS.USDC,
  amountIn: AMOUNT_UNI,
  inputUSD: INPUT_USD,
  expectedOutputUSD: INPUT_USD,
  slippageBps: SLIPPAGE_BPS,
  promptText: `Swap 0.1 UNI for USDC on Unichain mainnet (real funds, closes the most recent open UNI position). Continue?`,
});

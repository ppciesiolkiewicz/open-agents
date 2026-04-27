import { randomUUID } from 'node:crypto';
import type { TransactionReceipt } from 'viem';
import type { Database } from '../database/database';
import type { AgentConfig, Position, TokenAmount, Transaction } from '../database/types';
import type { Wallet } from '../wallet/wallet';
import { SwapQuoter, type SwapQuoterEnv } from './swap-quoter';
import { SwapExecutor, type SwapExecutorEnv } from './swap-executor';
import { PositionTracker } from './position-tracker';
import type { FeeTier, Quote } from './types';
import { UNICHAIN } from '../constants';

export interface UniswapServiceEnv extends SwapQuoterEnv, SwapExecutorEnv {}

export interface ExecuteSwapArgs {
  tokenIn: TokenAmount;
  tokenOut: TokenAmount;
  amountOutMinimum: bigint;
  feeTier: FeeTier;
  inputUSD: number;
  expectedOutputUSD: number;
}

export class UniswapService {
  private readonly quoter: SwapQuoter;
  private readonly executor: SwapExecutor;
  private readonly positionTracker: PositionTracker;

  constructor(env: UniswapServiceEnv, private readonly db: Database) {
    this.quoter = new SwapQuoter(env);
    this.executor = new SwapExecutor(env);
    this.positionTracker = new PositionTracker(db);
  }

  async getQuoteExactIn(args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    feeTier: FeeTier;
  }): Promise<Quote> {
    return this.quoter.quoteExactInputSingle(args);
  }

  async executeSwapExactIn(
    args: ExecuteSwapArgs,
    agent: AgentConfig,
    wallet: Wallet,
  ): Promise<{ swapTx: Transaction; approvalTxs: Transaction[]; opened?: Position; closed?: Position }> {
    const { swapReceipt, approvalReceipts } = await this.executor.executeSwap(
      {
        tokenIn: args.tokenIn.tokenAddress as `0x${string}`,
        tokenInDecimals: args.tokenIn.decimals,
        tokenOut: args.tokenOut.tokenAddress as `0x${string}`,
        tokenOutDecimals: args.tokenOut.decimals,
        amountIn: BigInt(args.tokenIn.amountRaw),
        amountOutMinimum: args.amountOutMinimum,
        feeTier: args.feeTier,
      },
      wallet,
    );

    const approvalTxs: Transaction[] = [];
    for (const receipt of approvalReceipts) {
      const tx = this.receiptToTransaction(agent.id, receipt, undefined, undefined);
      await this.db.transactions.insert(tx);
      approvalTxs.push(tx);
    }

    // Best-effort estimate of the received amount. We use the quote value
    // (already in args.tokenOut.amountRaw) rather than amountOutMinimum so
    // dry-run balances and Position.amount reflect typical fills, not the
    // worst-case slippage floor. The real receipt logs aren't parsed in v1;
    // actual received may be slightly higher or lower than this value.
    const actualTokenOut: TokenAmount = args.tokenOut;
    const swapTx = this.receiptToTransaction(agent.id, swapReceipt, args.tokenIn, actualTokenOut);
    await this.db.transactions.insert(swapTx);

    const { opened, closed } = await this.positionTracker.apply({
      agentId: agent.id,
      transactionId: swapTx.id,
      tokenIn: args.tokenIn,
      tokenOut: actualTokenOut,
      inputUSD: args.inputUSD,
      outputUSD: args.expectedOutputUSD,
    });

    return { swapTx, approvalTxs, opened, closed };
  }

  private receiptToTransaction(
    agentId: string,
    receipt: TransactionReceipt,
    tokenIn: TokenAmount | undefined,
    tokenOut: TokenAmount | undefined,
  ): Transaction {
    const gasUsed = receipt.gasUsed;
    const gasPriceWei = receipt.effectiveGasPrice;
    return {
      id: `tx-${randomUUID()}`,
      agentId,
      hash: receipt.transactionHash,
      chainId: UNICHAIN.chainId,
      from: (receipt.from ?? '0x0000000000000000000000000000000000000000') as string,
      to: (receipt.to ?? '0x0000000000000000000000000000000000000000') as string,
      ...(tokenIn ? { tokenIn } : {}),
      ...(tokenOut ? { tokenOut } : {}),
      gasUsed: gasUsed.toString(),
      gasPriceWei: gasPriceWei.toString(),
      gasCostWei: (gasUsed * gasPriceWei).toString(),
      status: receipt.status === 'success' ? 'success' : 'failed',
      blockNumber: receipt.blockNumber === 0n ? null : Number(receipt.blockNumber),
      timestamp: Date.now(),
    };
  }
}

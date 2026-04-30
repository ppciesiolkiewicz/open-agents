import { randomUUID } from 'node:crypto';
import type { Database } from '../database/database';
import type { Position, TokenAmount } from '../database/types';
import { USDC_ON_UNICHAIN } from '../constants';

const STABLE_TOKEN_ADDRESSES = new Set<string>([USDC_ON_UNICHAIN.address.toLowerCase()]);

export interface SwapResult {
  agentId: string;
  transactionId: string;
  tokenIn: TokenAmount;
  tokenOut: TokenAmount;
  inputUSD: number;
  outputUSD: number;
}

export class PositionTracker {
  constructor(private readonly db: Database) {}

  async apply(swap: SwapResult): Promise<{ opened?: Position; closed?: Position }> {
    const inIsStable = STABLE_TOKEN_ADDRESSES.has(swap.tokenIn.tokenAddress.toLowerCase());
    const outIsStable = STABLE_TOKEN_ADDRESSES.has(swap.tokenOut.tokenAddress.toLowerCase());

    if (inIsStable && !outIsStable) {
      const opened: Position = {
        id: `pos-${randomUUID()}`,
        agentId: swap.agentId,
        amount: swap.tokenOut,
        costBasisUSD: swap.inputUSD,
        openedByTransactionId: swap.transactionId,
        openedAt: Date.now(),
        closedAt: null,
        realizedPnlUSD: null,
      };
      await this.db.positions.insert(opened);
      return { opened };
    }

    if (!inIsStable && outIsStable) {
      const open = await this.db.positions.findOpen(swap.agentId, swap.tokenIn.tokenAddress);
      if (!open) return {};
      const closed: Position = {
        ...open,
        closedAt: Date.now(),
        closedByTransactionId: swap.transactionId,
        realizedPnlUSD: swap.outputUSD - open.costBasisUSD,
      };
      await this.db.positions.update(closed);
      return { closed };
    }

    return {};
  }
}

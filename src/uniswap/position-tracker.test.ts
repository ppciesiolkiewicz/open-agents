import { describe, it, expect, beforeEach } from 'vitest';
import { PositionTracker } from './position-tracker';
import { TOKENS } from '../constants';
import type { Database } from '../database/database';
import type { AgentRepository } from '../database/repositories/agent-repository';
import type { TransactionRepository } from '../database/repositories/transaction-repository';
import type { PositionRepository } from '../database/repositories/position-repository';
import type { AgentMemoryRepository } from '../database/repositories/agent-memory-repository';
import type { Position, TokenAmount } from '../database/types';

class InMemoryPositionRepo implements PositionRepository {
  positions: Position[] = [];
  async insert(pos: Position): Promise<void> { this.positions.push(pos); }
  async findOpen(agentId: string, tokenAddress: string): Promise<Position | null> {
    const open = this.positions.filter(
      (p) => p.agentId === agentId && p.amount.tokenAddress === tokenAddress && p.closedAt === null,
    );
    return open[open.length - 1] ?? null;
  }
  async listByAgent(agentId: string): Promise<Position[]> {
    return this.positions.filter((p) => p.agentId === agentId);
  }
  async update(pos: Position): Promise<void> {
    const idx = this.positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) throw new Error(`Position ${pos.id} not found`);
    this.positions[idx] = pos;
  }
}

function makeDb(positions: InMemoryPositionRepo): Database {
  return {
    agents: {} as AgentRepository,
    transactions: {} as TransactionRepository,
    positions,
    agentMemory: {} as AgentMemoryRepository,
  };
}

const usdcAmount = (raw: string): TokenAmount => ({
  tokenAddress: TOKENS.USDC.address,
  symbol: 'USDC',
  amountRaw: raw,
  decimals: 6,
});
const uniAmount = (raw: string): TokenAmount => ({
  tokenAddress: TOKENS.UNI.address,
  symbol: 'UNI',
  amountRaw: raw,
  decimals: 18,
});

describe('PositionTracker.apply', () => {
  let positions: InMemoryPositionRepo;
  let tracker: PositionTracker;

  beforeEach(() => {
    positions = new InMemoryPositionRepo();
    tracker = new PositionTracker(makeDb(positions));
  });

  it('opens a position when buying a non-stable token (USDC → UNI)', async () => {
    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-buy-1',
      tokenIn: usdcAmount('100000000'),
      tokenOut: uniAmount('30000000000000000000'),
      inputUSD: 100,
      outputUSD: 100,
    });

    expect(result.opened).toBeDefined();
    expect(result.opened!.amount.symbol).toBe('UNI');
    expect(result.opened!.costBasisUSD).toBe(100);
    expect(result.opened!.openedByTransactionId).toBe('tx-buy-1');
    expect(positions.positions).toHaveLength(1);
  });

  it('closes the most-recent open UNI position when selling UNI → USDC, with realized PnL', async () => {
    await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-buy-1',
      tokenIn: usdcAmount('100000000'),
      tokenOut: uniAmount('30000000000000000000'),
      inputUSD: 100,
      outputUSD: 100,
    });

    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-sell-1',
      tokenIn: uniAmount('30000000000000000000'),
      tokenOut: usdcAmount('120000000'),
      inputUSD: 120,
      outputUSD: 120,
    });

    expect(result.closed).toBeDefined();
    expect(result.closed!.closedByTransactionId).toBe('tx-sell-1');
    expect(result.closed!.realizedPnlUSD).toBe(20);
    expect(positions.positions[0]!.closedAt).not.toBeNull();
  });

  it('no-op when both legs are non-stable', async () => {
    const otherToken: TokenAmount = {
      tokenAddress: '0x000000000000000000000000000000000000babe',
      symbol: 'OTHER',
      amountRaw: '1',
      decimals: 18,
    };
    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-x',
      tokenIn: uniAmount('30000000000000000000'),
      tokenOut: otherToken,
      inputUSD: 100,
      outputUSD: 100,
    });
    expect(result).toEqual({});
    expect(positions.positions).toHaveLength(0);
  });

  it('no-op when selling a token with no open position', async () => {
    const result = await tracker.apply({
      agentId: 'a1',
      transactionId: 'tx-orphan-sell',
      tokenIn: uniAmount('30000000000000000000'),
      tokenOut: usdcAmount('100000000'),
      inputUSD: 100,
      outputUSD: 100,
    });
    expect(result).toEqual({});
  });
});

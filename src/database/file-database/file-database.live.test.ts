import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDatabase } from './file-database';
import type {
  AgentConfig,
  Transaction,
  Position,
  AgentMemory,
  TokenAmount,
} from '../types';

const usdc: TokenAmount = {
  tokenAddress: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  symbol: 'USDC',
  amountRaw: '1000000000',
  decimals: 6,
};

const uni: TokenAmount = {
  tokenAddress: '0x8f187aA05619a017077f5308904739877ce9eA21',
  symbol: 'UNI',
  amountRaw: '500000000000000000',
  decimals: 18,
};

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    running: true,
    intervalMs: 180_000,
    prompt: 'do the thing',
    dryRun: true,
    dryRunSeedBalances: { native: '100000000000000000', [usdc.tokenAddress]: '1000000000' },
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

function makeTx(id: string, agentId: string): Transaction {
  return {
    id,
    agentId,
    hash: `0x${'0'.repeat(60)}${id.padStart(4, '0')}`,
    chainId: 130,
    from: '0xabc',
    to: '0xdef',
    tokenIn: usdc,
    tokenOut: uni,
    gasUsed: '150000',
    gasPriceWei: '1000000000',
    gasCostWei: '150000000000000',
    status: 'success',
    blockNumber: null,
    timestamp: Date.now(),
  };
}

function makePos(id: string, agentId: string, openedByTx: string): Position {
  return {
    id,
    agentId,
    amount: uni,
    costBasisUSD: 50,
    openedByTransactionId: openedByTx,
    openedAt: Date.now(),
    closedAt: null,
    realizedPnlUSD: null,
  };
}

describe('FileDatabase (live, real filesystem)', () => {
  let dbDir: string;
  let db: FileDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-db-'));
    db = new FileDatabase(dbDir);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('round-trips an AgentConfig (upsert → list → findById)', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);

    const loaded = await db.agents.findById('a1');
    expect(loaded).toEqual(agent);

    const all = await db.agents.list();
    expect(all).toEqual([agent]);

    console.log('[file-database] agent round-trip OK:', loaded?.id);
  });

  it('upsert replaces existing agent by id (no duplicate)', async () => {
    const agent = makeAgent('a1');
    await db.agents.upsert(agent);
    await db.agents.upsert({ ...agent, name: 'renamed' });

    const all = await db.agents.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('renamed');
  });

  it('returns null for missing agent', async () => {
    expect(await db.agents.findById('nope')).toBeNull();
    expect(await db.agents.list()).toEqual([]);
  });

  it('round-trips Transactions (insert → findById → listByAgent)', async () => {
    await db.agents.upsert(makeAgent('a1'));
    const tx1 = makeTx('1', 'a1');
    const tx2 = makeTx('2', 'a1');
    const tx3 = makeTx('3', 'a2');
    await db.transactions.insert(tx1);
    await db.transactions.insert(tx2);
    await db.transactions.insert(tx3);

    expect(await db.transactions.findById('1')).toEqual(tx1);
    const a1 = await db.transactions.listByAgent('a1');
    expect(a1).toEqual([tx1, tx2]);
    const a1last = await db.transactions.listByAgent('a1', { limit: 1 });
    expect(a1last).toEqual([tx2]);

    console.log('[file-database] transactions for a1:', a1.length);
  });

  it('updates transaction status', async () => {
    const tx = makeTx('1', 'a1');
    await db.transactions.insert(tx);

    await db.transactions.updateStatus('1', {
      status: 'success',
      blockNumber: 42,
      hash: '0xabcd',
    });

    const loaded = await db.transactions.findById('1');
    expect(loaded?.status).toBe('success');
    expect(loaded?.blockNumber).toBe(42);
    expect(loaded?.hash).toBe('0xabcd');
  });

  it('round-trips Positions (insert → findOpen → listByAgent → update)', async () => {
    await db.agents.upsert(makeAgent('a1'));
    await db.transactions.insert(makeTx('1', 'a1'));
    const pos = makePos('p1', 'a1', '1');
    await db.positions.insert(pos);

    const open = await db.positions.findOpen('a1', uni.tokenAddress);
    expect(open).toEqual(pos);

    const all = await db.positions.listByAgent('a1');
    expect(all).toEqual([pos]);

    const closed = { ...pos, closedAt: Date.now(), closedByTransactionId: '2', realizedPnlUSD: 5 };
    await db.positions.update(closed);
    expect(await db.positions.findOpen('a1', uni.tokenAddress)).toBeNull();

    console.log('[file-database] position closed with PnL:', closed.realizedPnlUSD);
  });

  it('round-trips AgentMemory in its own per-agent file', async () => {
    const mem: AgentMemory = {
      agentId: 'a1',
      notes: 'short MA below long MA',
      state: { priceHistory: [3.21, 3.22, 3.20] },
      updatedAt: Date.now(),
      entries: [],
    };
    await db.agentMemory.upsert(mem);

    const loaded = await db.agentMemory.get('a1');
    expect(loaded).toEqual(mem);

    expect(await db.agentMemory.get('nope')).toBeNull();

    // Verify the per-agent file actually exists at the documented path.
    const onDisk = JSON.parse(await readFile(join(dbDir, 'memory', 'a1.json'), 'utf8'));
    expect(onDisk.agentId).toBe('a1');
    console.log('[file-database] memory file OK for agent a1');
  });

  it('persists across FileDatabase instances (re-open)', async () => {
    await db.agents.upsert(makeAgent('a1'));
    await db.transactions.insert(makeTx('1', 'a1'));

    const db2 = new FileDatabase(dbDir);
    expect(await db2.agents.list()).toHaveLength(1);
    expect(await db2.transactions.findById('1')).not.toBeNull();
  });

  it('keeps agents, transactions, and positions in the SAME database.json', async () => {
    await db.agents.upsert(makeAgent('a1'));
    await db.transactions.insert(makeTx('1', 'a1'));
    await db.positions.insert(makePos('p1', 'a1', '1'));

    const onDisk = JSON.parse(await readFile(join(dbDir, 'database.json'), 'utf8'));
    expect(onDisk.agents).toHaveLength(1);
    expect(onDisk.transactions).toHaveLength(1);
    expect(onDisk.positions).toHaveLength(1);
  });
});

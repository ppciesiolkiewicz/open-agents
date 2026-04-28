import { it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { describeIfPostgres, getTestPrisma, truncateAll } from './test-helpers';
import { PrismaAgentRepository } from './prisma-agent-repository';
import { PrismaTransactionRepository } from './prisma-transaction-repository';
import { PrismaPositionRepository } from './prisma-position-repository';
import { PrismaAgentMemoryRepository } from './prisma-agent-memory-repository';
import { PrismaUserRepository } from './prisma-user-repository';
import { PrismaUserWalletRepository } from './prisma-user-wallet-repository';
import type { AgentConfig, Transaction, TokenAmount, Position, AgentMemory, User, UserWallet } from '../types';

describeIfPostgres('PrismaAgentRepository', () => {
  const prisma = getTestPrisma()!;
  const repo = new PrismaAgentRepository(prisma);
  const userRepo = new PrismaUserRepository(prisma);
  let TEST_USER_ID: string;

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    const u = await userRepo.findOrCreateByPrivyDid('did:privy:test', {});
    TEST_USER_ID = u.id;
  });

  function makeAgent(id: string): AgentConfig {
    return {
      id,
      userId: TEST_USER_ID,
      name: `agent-${id}`,
      prompt: 'do the thing',
      dryRun: true,
      dryRunSeedBalances: { native: '1000' },
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 },
      createdAt: Date.now(),
      running: true,
      intervalMs: 180_000,
      lastTickAt: null,
    };
  }

  it('upsert + findById round-trip', async () => {
    const a = makeAgent('agent-1');
    await repo.upsert(a);
    const got = await repo.findById('agent-1');
    expect(got).not.toBeNull();
    expect(got?.id).toBe('agent-1');
    expect(got?.dryRun).toBe(true);
    expect(got?.riskLimits.maxTradeUSD).toBe(100);
    expect(got?.dryRunSeedBalances).toEqual({ native: '1000' });
    console.log('agent.findById →', got);
  });

  it('list returns all agents', async () => {
    await repo.upsert(makeAgent('a'));
    await repo.upsert(makeAgent('b'));
    const all = await repo.list();
    expect(all).toHaveLength(2);
    console.log('agent.list →', all.map((a) => a.id));
  });

  it('upsert updates existing row', async () => {
    const a = makeAgent('agent-1');
    await repo.upsert(a);
    await repo.upsert({ ...a, name: 'renamed' });
    const got = await repo.findById('agent-1');
    expect(got?.name).toBe('renamed');
  });

  it('delete removes the row', async () => {
    await repo.upsert(makeAgent('agent-1'));
    await repo.delete('agent-1');
    expect(await repo.findById('agent-1')).toBeNull();
  });

  it('findById returns null for missing agent', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });
});

describeIfPostgres('PrismaTransactionRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const txs = new PrismaTransactionRepository(prisma);
  const userRepo = new PrismaUserRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    const u = await userRepo.findOrCreateByPrivyDid('did:privy:test', {});
    await agents.upsert({
      id: 'a1', userId: u.id, name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  const usdc: TokenAmount = {
    tokenAddress: '0xUSDC',
    symbol: 'USDC',
    amountRaw: '1000000000',
    decimals: 6,
  };

  function makeTx(id: string, agentId = 'a1'): Transaction {
    return {
      id,
      agentId,
      hash: `0x${'0'.repeat(60)}${id.padStart(4, '0')}`,
      chainId: 130,
      fromAddress: '0xabc',
      toAddress: '0xdef',
      tokenIn: usdc,
      tokenOut: undefined,
      gasUsed: '21000',
      gasPriceWei: '1000000000',
      gasCostWei: '21000000000000',
      status: 'success',
      blockNumber: 12345,
      timestamp: Date.now(),
    };
  }

  it('insert + findById', async () => {
    await txs.insert(makeTx('t1'));
    const got = await txs.findById('t1');
    expect(got?.id).toBe('t1');
    expect(got?.tokenIn?.symbol).toBe('USDC');
    expect(got?.gasUsed).toBe('21000');
    console.log('tx.findById →', got);
  });

  it('listByAgent with limit returns last N in chronological order', async () => {
    for (let i = 1; i <= 5; i++) {
      await txs.insert({ ...makeTx(`t${i}`), timestamp: i });
    }
    const last3 = await txs.listByAgent('a1', { limit: 3 });
    expect(last3).toHaveLength(3);
    expect(last3.map((t) => t.id)).toEqual(['t3', 't4', 't5']);
  });

  it('updateStatus mutates only allowed fields', async () => {
    await txs.insert({ ...makeTx('t1'), status: 'pending', blockNumber: null, hash: '0xpending' });
    await txs.updateStatus('t1', { status: 'success', blockNumber: 999, hash: '0xfinal' });
    const got = await txs.findById('t1');
    expect(got?.status).toBe('success');
    expect(got?.blockNumber).toBe(999);
    expect(got?.hash).toBe('0xfinal');
  });
});

describeIfPostgres('PrismaPositionRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const positions = new PrismaPositionRepository(prisma);
  const userRepo = new PrismaUserRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    const u = await userRepo.findOrCreateByPrivyDid('did:privy:test', {});
    await agents.upsert({
      id: 'a1', userId: u.id, name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  function makePos(id: string, opts: { closed?: boolean; tokenAddress?: string } = {}): Position {
    return {
      id,
      agentId: 'a1',
      amount: {
        tokenAddress: opts.tokenAddress ?? '0xUNI',
        symbol: 'UNI',
        amountRaw: '500000000000000000',
        decimals: 18,
      },
      costBasisUSD: 5,
      openedByTransactionId: 'tx-open',
      closedByTransactionId: opts.closed ? 'tx-close' : undefined,
      openedAt: Date.now(),
      closedAt: opts.closed ? Date.now() : null,
      realizedPnlUSD: opts.closed ? 1.5 : null,
    };
  }

  it('insert + listByAgent', async () => {
    await positions.insert(makePos('p1'));
    await positions.insert(makePos('p2', { closed: true }));
    const all = await positions.listByAgent('a1');
    expect(all).toHaveLength(2);
    console.log('positions.listByAgent →', all.map((p) => ({ id: p.id, closed: p.closedAt !== null })));
  });

  it('findOpen returns the open position for the token', async () => {
    await positions.insert(makePos('p1'));
    await positions.insert(makePos('p2', { closed: true, tokenAddress: '0xOTHER' }));
    const open = await positions.findOpen('a1', '0xUNI');
    expect(open?.id).toBe('p1');
  });

  it('findOpen returns null when only closed positions exist', async () => {
    await positions.insert(makePos('p1', { closed: true }));
    const open = await positions.findOpen('a1', '0xUNI');
    expect(open).toBeNull();
  });

  it('update mutates the row', async () => {
    await positions.insert(makePos('p1'));
    const updated = makePos('p1', { closed: true });
    await positions.update(updated);
    const got = (await positions.listByAgent('a1'))[0];
    expect(got?.closedAt).not.toBeNull();
    expect(got?.realizedPnlUSD).toBe(1.5);
  });
});

describeIfPostgres('PrismaAgentMemoryRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const memory = new PrismaAgentMemoryRepository(prisma);
  const userRepo = new PrismaUserRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    const u = await userRepo.findOrCreateByPrivyDid('did:privy:test', {});
    await agents.upsert({
      id: 'a1', userId: u.id, name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  function makeMemory(): AgentMemory {
    return {
      agentId: 'a1',
      notes: 'hello',
      state: { lastPriceUSD: 5.5, mode: 'observe' },
      updatedAt: Date.now(),
      entries: [
        { id: 'e1', tickId: 't1', type: 'observation', content: 'noted price', createdAt: Date.now() },
        { id: 'e2', tickId: 't2', type: 'snapshot', content: 'snap', parentEntryIds: ['e1'], createdAt: Date.now() + 1 },
      ],
    };
  }

  it('upsert + get round-trip with entries', async () => {
    await memory.upsert(makeMemory());
    const got = await memory.get('a1');
    expect(got?.notes).toBe('hello');
    expect(got?.state).toEqual({ lastPriceUSD: 5.5, mode: 'observe' });
    expect(got?.entries).toHaveLength(2);
    expect(got?.entries[1]?.parentEntryIds).toEqual(['e1']);
    console.log('memory.get →', got);
  });

  it('upsert overwrites entries (full replace semantics matches file impl)', async () => {
    const m = makeMemory();
    await memory.upsert(m);
    await memory.upsert({ ...m, entries: [{ id: 'e3', tickId: 't3', type: 'note', content: 'new', createdAt: Date.now() }] });
    const got = await memory.get('a1');
    expect(got?.entries).toHaveLength(1);
    expect(got?.entries[0]?.id).toBe('e3');
  });

  it('get returns null for unknown agent', async () => {
    expect(await memory.get('nope')).toBeNull();
  });
});

describeIfPostgres('PrismaUserRepository', () => {
  const prisma = getTestPrisma()!;
  const users = new PrismaUserRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('findOrCreateByPrivyDid creates a row on first call', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'a@b.c' });
    expect(u.privyDid).toBe('did:privy:abc');
    expect(u.email).toBe('a@b.c');
    expect(u.id).toBeTruthy();
    console.log('user.findOrCreateByPrivyDid →', u);
  });

  it('findOrCreateByPrivyDid is idempotent', async () => {
    const a = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'a@b.c' });
    const b = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'a@b.c' });
    expect(b.id).toBe(a.id);
  });

  it('findOrCreateByPrivyDid updates email on second call when changed', async () => {
    await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'old@x.com' });
    const updated = await users.findOrCreateByPrivyDid('did:privy:abc', { email: 'new@x.com' });
    expect(updated.email).toBe('new@x.com');
  });

  it('findByPrivyDid returns null for unknown DID', async () => {
    expect(await users.findByPrivyDid('did:privy:nope')).toBeNull();
  });

  it('findById returns null for unknown id', async () => {
    expect(await users.findById('not-a-real-id')).toBeNull();
  });
});

describeIfPostgres('PrismaUserWalletRepository', () => {
  const prisma = getTestPrisma()!;
  const users = new PrismaUserRepository(prisma);
  const wallets = new PrismaUserWalletRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  function makeWallet(opts: { userId: string; privyWalletId?: string; isPrimary?: boolean }): UserWallet {
    return {
      id: randomUUID(),
      userId: opts.userId,
      privyWalletId: opts.privyWalletId ?? randomUUID(),
      walletAddress: '0xabc',
      isPrimary: opts.isPrimary ?? true,
      createdAt: Date.now(),
    };
  }

  it('insert + findById round-trip', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    const w = makeWallet({ userId: u.id });
    await wallets.insert(w);
    const got = await wallets.findById(w.id);
    expect(got?.privyWalletId).toBe(w.privyWalletId);
    expect(got?.isPrimary).toBe(true);
    console.log('userWallet.findById →', got);
  });

  it('findPrimaryByUser returns the primary wallet, ignores non-primary', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    await wallets.insert(makeWallet({ userId: u.id, isPrimary: false }));
    const primary = makeWallet({ userId: u.id, isPrimary: true });
    await wallets.insert(primary);
    const got = await wallets.findPrimaryByUser(u.id);
    expect(got?.id).toBe(primary.id);
  });

  it('findPrimaryByUser returns null when user has no wallets', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    expect(await wallets.findPrimaryByUser(u.id)).toBeNull();
  });

  it('listByUser returns all wallets for the user', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    await wallets.insert(makeWallet({ userId: u.id, isPrimary: true }));
    await wallets.insert(makeWallet({ userId: u.id, isPrimary: false }));
    const all = await wallets.listByUser(u.id);
    expect(all).toHaveLength(2);
  });

  it('privyWalletId uniqueness is enforced', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    const shared = 'privy-wallet-shared';
    await wallets.insert(makeWallet({ userId: u.id, privyWalletId: shared }));
    await expect(
      wallets.insert(makeWallet({ userId: u.id, privyWalletId: shared })),
    ).rejects.toThrow();
  });

  it('findByPrivyWalletId returns the row', async () => {
    const u = await users.findOrCreateByPrivyDid('did:privy:1', {});
    const w = makeWallet({ userId: u.id, privyWalletId: 'pw-1' });
    await wallets.insert(w);
    const got = await wallets.findByPrivyWalletId('pw-1');
    expect(got?.id).toBe(w.id);
  });
});

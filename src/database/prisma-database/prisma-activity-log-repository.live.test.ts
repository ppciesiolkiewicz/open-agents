import { it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { describeIfPostgres, getTestPrisma, truncateAll } from './test-helpers';
import { PrismaAgentRepository } from './prisma-agent-repository';
import { PrismaActivityLogRepository } from './prisma-activity-log-repository';

describeIfPostgres('PrismaActivityLogRepository', () => {
  const prisma = getTestPrisma()!;
  const agents = new PrismaAgentRepository(prisma);
  const log = new PrismaActivityLogRepository(prisma);

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    await agents.upsert({
      id: 'a1', name: 'a1', prompt: '', dryRun: true,
      riskLimits: { maxTradeUSD: 100, maxSlippageBps: 50 }, createdAt: Date.now(),
    });
  });

  it('append assigns monotonically increasing seq', async () => {
    const e1 = await log.append({ agentId: 'a1', tickId: 't1', timestamp: 1, type: 'tick_start', payload: {} });
    const e2 = await log.append({ agentId: 'a1', tickId: 't1', timestamp: 2, type: 'tick_end', payload: {} });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    console.log('append seqs →', { s1: e1.seq, s2: e2.seq });
  });

  it('listByAgent returns entries ordered by seq ascending', async () => {
    for (let i = 0; i < 5; i++) {
      await log.append({ agentId: 'a1', tickId: `t${i}`, timestamp: i, type: 'tick_start', payload: { i } });
    }
    const all = await log.listByAgent('a1');
    expect(all).toHaveLength(5);
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
    }
  });

  it('listByAgent with limit returns last N', async () => {
    for (let i = 0; i < 10; i++) {
      await log.append({ agentId: 'a1', tickId: `t${i}`, timestamp: i, type: 'tick_start', payload: { i } });
    }
    const tail = await log.listByAgent('a1', { limit: 3 });
    expect(tail).toHaveLength(3);
    expect(tail.map((e) => e.payload.i)).toEqual([7, 8, 9]);
  });

  it('listByAgent with sinceTickId returns entries after the LAST entry of the anchor tick', async () => {
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 1, type: 'tick_start', payload: {} });
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 2, type: 'llm_call', payload: { model: 'x', promptChars: 0 } });
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 3, type: 'tick_end', payload: {} });
    await log.append({ agentId: 'a1', tickId: 't2', timestamp: 4, type: 'tick_start', payload: {} });
    await log.append({ agentId: 'a1', tickId: 't2', timestamp: 5, type: 'tick_end', payload: {} });

    const after = await log.listByAgent('a1', { sinceTickId: 't1' });
    expect(after).toHaveLength(2);
    expect(after.every((e) => e.tickId === 't2')).toBe(true);
  });

  it('listByAgent with sinceTickId returns all when anchor not found', async () => {
    await log.append({ agentId: 'a1', tickId: 't1', timestamp: 1, type: 'tick_start', payload: {} });
    const all = await log.listByAgent('a1', { sinceTickId: 'never-existed' });
    expect(all).toHaveLength(1);
  });
});

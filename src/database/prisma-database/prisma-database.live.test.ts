import { it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { describeIfPostgres, getTestPrisma, truncateAll } from './test-helpers';
import { PrismaAgentRepository } from './prisma-agent-repository';
import type { AgentConfig } from '../types';

describeIfPostgres('PrismaAgentRepository', () => {
  const prisma = getTestPrisma()!;
  const repo = new PrismaAgentRepository(prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  function makeAgent(id: string): AgentConfig {
    return {
      id,
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

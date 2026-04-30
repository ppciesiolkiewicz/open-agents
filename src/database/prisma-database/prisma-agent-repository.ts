import { Prisma, type PrismaClient } from '@prisma/client';
import type { AgentConfig } from '../types';
import type { AgentRepository } from '../repositories/agent-repository';
import { agentRowToDomain } from './mappers';

export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(agentRowToDomain);
  }

  async listByUser(userId: string): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(agentRowToDomain);
  }

  async findById(id: string): Promise<AgentConfig | null> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    return row ? agentRowToDomain(row) : null;
  }

  async upsert(agent: AgentConfig): Promise<void> {
    const data = {
      userId: agent.userId,
      name: agent.name,
      prompt: agent.prompt,
      dryRun: agent.dryRun,
      dryRunSeedBalances: (agent.dryRunSeedBalances ?? Prisma.DbNull) as Prisma.InputJsonValue,
      allowedTokens: agent.allowedTokens,
      riskLimits: agent.riskLimits as Prisma.InputJsonValue,
      createdAt: BigInt(agent.createdAt),
      running: agent.running ?? null,
      intervalMs: agent.intervalMs ?? null,
      lastTickAt:
        agent.lastTickAt === null || agent.lastTickAt === undefined
          ? null
          : BigInt(agent.lastTickAt),
    };
    await this.prisma.agent.upsert({
      where: { id: agent.id },
      create: { id: agent.id, ...data },
      update: data,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.agent.delete({ where: { id } }).catch((err) => {
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    });
  }
}

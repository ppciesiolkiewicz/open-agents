import { Prisma, type PrismaClient, type Agent as PrismaAgent } from '@prisma/client';
import type { AgentConfig } from '../types';
import type { AgentRepository } from '../repositories/agent-repository';
import { agentRowToDomain } from './mappers';

export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
    return this.withConnections(rows);
  }

  async listByUser(userId: string): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return this.withConnections(rows);
  }

  async findById(id: string): Promise<AgentConfig | null> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    if (!row) return null;
    const connectedAgentIds = await this.listConnectedAgentIds([row.id]);
    return {
      ...agentRowToDomain(row),
      connectedAgentIds: connectedAgentIds.get(row.id) ?? [],
    };
  }

  async upsert(agent: AgentConfig): Promise<void> {
    const data = {
      userId: agent.userId,
      name: agent.name,
      prompt: agent.prompt,
      dryRun: agent.dryRun,
      dryRunSeedBalances: (agent.dryRunSeedBalances ?? Prisma.DbNull) as Prisma.InputJsonValue,
      allowedTokens: agent.allowedTokens,
      toolIds: agent.toolIds ?? [],
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

  async setAxlConnections(agentId: string, connectedAgentIds: string[]): Promise<void> {
    const normalized = Array.from(new Set(connectedAgentIds.filter((id) => id !== agentId)));
    const canonicalPairs = normalized.map((otherId) => this.toCanonicalPair(agentId, otherId));
    await this.prisma.$transaction(async (tx) => {
      await tx.axlAgentConnection.deleteMany({
        where: {
          OR: [{ agentAId: agentId }, { agentBId: agentId }],
        },
      });
      if (canonicalPairs.length > 0) {
        await tx.axlAgentConnection.createMany({
          data: canonicalPairs.map((pair) => ({
            agentAId: pair.agentAId,
            agentBId: pair.agentBId,
            createdAt: BigInt(Date.now()),
          })),
          skipDuplicates: true,
        });
      }
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.agent.delete({ where: { id } }).catch((err) => {
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    });
  }

  private async withConnections(rows: PrismaAgent[]): Promise<AgentConfig[]> {
    const byAgentId = await this.listConnectedAgentIds(rows.map((row) => row.id));
    return rows.map((row) => ({
      ...agentRowToDomain(row),
      connectedAgentIds: byAgentId.get(row.id) ?? [],
    }));
  }

  private async listConnectedAgentIds(agentIds: string[]): Promise<Map<string, string[]>> {
    const unique = Array.from(new Set(agentIds));
    const map = new Map<string, string[]>();
    for (const agentId of unique) map.set(agentId, []);
    if (unique.length === 0) return map;
    const rows = await this.prisma.axlAgentConnection.findMany({
      where: {
        OR: [
          { agentAId: { in: unique } },
          { agentBId: { in: unique } },
        ],
      },
      orderBy: [{ agentAId: 'asc' }, { agentBId: 'asc' }],
    });
    for (const row of rows) {
      if (map.has(row.agentAId)) map.get(row.agentAId)!.push(row.agentBId);
      if (map.has(row.agentBId)) map.get(row.agentBId)!.push(row.agentAId);
    }
    return map;
  }

  private toCanonicalPair(agentId: string, otherId: string): { agentAId: string; agentBId: string } {
    return agentId < otherId
      ? { agentAId: agentId, agentBId: otherId }
      : { agentAId: otherId, agentBId: agentId };
  }
}

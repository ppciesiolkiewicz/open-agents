import { Prisma, type PrismaClient, type Agent as PrismaAgent } from '@prisma/client';
import type { AgentConfig, AxlChannel } from '../types';
import type { AgentRepository } from '../repositories/agent-repository';
import { agentRowToDomain } from './mappers';

export class PrismaAgentRepository implements AgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
    return this.withAxlTopology(rows);
  }

  async listByUser(userId: string): Promise<AgentConfig[]> {
    const rows = await this.prisma.agent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return this.withAxlTopology(rows);
  }

  async findById(id: string): Promise<AgentConfig | null> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    if (!row) return null;
    const connectedAgentIds = await this.listConnectedAgentIds([row.id]);
    const connectedChannelIds = await this.listConnectedChannelIds([row.id]);
    return {
      ...agentRowToDomain(row),
      connectedAgentIds: connectedAgentIds.get(row.id) ?? [],
      connectedChannelIds: connectedChannelIds.get(row.id) ?? [],
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

  async createAxlChannel(input: {
    id: string;
    userId: string;
    name: string;
    createdAt: number;
  }): Promise<AxlChannel> {
    await this.prisma.axlChannel.create({
      data: {
        id: input.id,
        userId: input.userId,
        name: input.name,
        createdAt: BigInt(input.createdAt),
      },
    });
    return {
      id: input.id,
      userId: input.userId,
      name: input.name,
      createdAt: input.createdAt,
      memberAgentIds: [],
    };
  }

  async listAxlChannelsByUser(userId: string): Promise<AxlChannel[]> {
    const rows = await this.prisma.axlChannel.findMany({
      where: { userId },
      include: { memberships: { orderBy: { agentId: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      createdAt: Number(row.createdAt),
      memberAgentIds: row.memberships.map((m) => m.agentId),
    }));
  }

  async findAxlChannelById(channelId: string): Promise<AxlChannel | null> {
    const row = await this.prisma.axlChannel.findUnique({
      where: { id: channelId },
      include: { memberships: { orderBy: { agentId: 'asc' } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      createdAt: Number(row.createdAt),
      memberAgentIds: row.memberships.map((m) => m.agentId),
    };
  }

  async deleteAxlChannel(channelId: string): Promise<void> {
    await this.prisma.axlChannel.delete({ where: { id: channelId } }).catch((err) => {
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    });
  }

  async addAgentToAxlChannel(agentId: string, channelId: string): Promise<void> {
    await this.prisma.axlChannelMembership.create({
      data: {
        channelId,
        agentId,
        createdAt: BigInt(Date.now()),
      },
    }).catch((err) => {
      if ((err as { code?: string }).code === 'P2002') return;
      throw err;
    });
  }

  async removeAgentFromAxlChannel(agentId: string, channelId: string): Promise<void> {
    await this.prisma.axlChannelMembership.delete({
      where: { channelId_agentId: { channelId, agentId } },
    }).catch((err) => {
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.agent.delete({ where: { id } }).catch((err) => {
      if ((err as { code?: string }).code === 'P2025') return;
      throw err;
    });
  }

  private async withAxlTopology(rows: PrismaAgent[]): Promise<AgentConfig[]> {
    const connectedByAgentId = await this.listConnectedAgentIds(rows.map((row) => row.id));
    const channelsByAgentId = await this.listConnectedChannelIds(rows.map((row) => row.id));
    return rows.map((row) => ({
      ...agentRowToDomain(row),
      connectedAgentIds: connectedByAgentId.get(row.id) ?? [],
      connectedChannelIds: channelsByAgentId.get(row.id) ?? [],
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

  private async listConnectedChannelIds(agentIds: string[]): Promise<Map<string, string[]>> {
    const unique = Array.from(new Set(agentIds));
    const map = new Map<string, string[]>();
    for (const agentId of unique) map.set(agentId, []);
    if (unique.length === 0) return map;
    const rows = await this.prisma.axlChannelMembership.findMany({
      where: { agentId: { in: unique } },
      orderBy: [{ agentId: 'asc' }, { channelId: 'asc' }],
    });
    for (const row of rows) {
      if (map.has(row.agentId)) map.get(row.agentId)!.push(row.channelId);
    }
    return map;
  }

  private toCanonicalPair(agentId: string, otherId: string): { agentAId: string; agentBId: string } {
    return agentId < otherId
      ? { agentAId: agentId, agentBId: otherId }
      : { agentAId: otherId, agentBId: agentId };
  }
}

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ActivityLogRepository } from '../repositories/activity-log-repository';
import type { AgentActivityLogEntry, AgentActivityLogEntryInput } from '../types';
import { activityEventRowToDomain } from './mappers';

export class PrismaActivityLogRepository implements ActivityLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: AgentActivityLogEntryInput): Promise<AgentActivityLogEntry> {
    const row = await this.prisma.activityEvent.create({
      data: {
        id: randomUUID(),
        agentId: entry.agentId,
        tickId: entry.tickId,
        type: entry.type,
        payload: entry.payload as object,
        timestamp: BigInt(entry.timestamp),
      },
    });
    return activityEventRowToDomain(row);
  }

  async listByAgent(
    agentId: string,
    opts?: { limit?: number; sinceTickId?: string },
  ): Promise<AgentActivityLogEntry[]> {
    const where: { agentId: string; seq?: { gt: bigint } } = { agentId };

    if (opts?.sinceTickId) {
      const anchor = await this.prisma.activityEvent.findFirst({
        where: { agentId, tickId: opts.sinceTickId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      if (anchor !== null) {
        where.seq = { gt: anchor.seq };
      }
    }

    // Negative `take` returns the last N rows in the requested order — keeps
    // the tail-slice on the database side instead of streaming everything
    // into memory.
    const rows = await this.prisma.activityEvent.findMany({
      where,
      orderBy: { seq: 'asc' },
      ...(typeof opts?.limit === 'number' ? { take: -opts.limit } : {}),
    });
    return rows.map(activityEventRowToDomain);
  }
}

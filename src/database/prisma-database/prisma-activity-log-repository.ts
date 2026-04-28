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
        level: 'info',
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
    let entries: AgentActivityLogEntry[];

    if (opts?.sinceTickId) {
      const anchor = await this.prisma.activityEvent.findFirst({
        where: { agentId, tickId: opts.sinceTickId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      if (anchor === null) {
        const rows = await this.prisma.activityEvent.findMany({
          where: { agentId },
          orderBy: { seq: 'asc' },
        });
        entries = rows.map(activityEventRowToDomain);
      } else {
        const rows = await this.prisma.activityEvent.findMany({
          where: { agentId, seq: { gt: anchor.seq } },
          orderBy: { seq: 'asc' },
        });
        entries = rows.map(activityEventRowToDomain);
      }
    } else {
      const rows = await this.prisma.activityEvent.findMany({
        where: { agentId },
        orderBy: { seq: 'asc' },
      });
      entries = rows.map(activityEventRowToDomain);
    }

    if (typeof opts?.limit === 'number') {
      entries = entries.slice(-opts.limit);
    }
    return entries;
  }
}

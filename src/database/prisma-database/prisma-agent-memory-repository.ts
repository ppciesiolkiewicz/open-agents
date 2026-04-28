import type { PrismaClient } from '@prisma/client';
import type { AgentMemory } from '../types';
import type { AgentMemoryRepository } from '../repositories/agent-memory-repository';
import { memoryRowToDomain } from './mappers';

export class PrismaAgentMemoryRepository implements AgentMemoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(agentId: string): Promise<AgentMemory | null> {
    const row = await this.prisma.agentMemory.findUnique({
      where: { agentId },
      include: { entries: { orderBy: { createdAt: 'asc' } } },
    });
    return row ? memoryRowToDomain(row) : null;
  }

  async upsert(memory: AgentMemory): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.agentMemory.upsert({
        where: { agentId: memory.agentId },
        create: {
          agentId: memory.agentId,
          notes: memory.notes,
          state: memory.state as object,
          updatedAt: BigInt(memory.updatedAt),
        },
        update: {
          notes: memory.notes,
          state: memory.state as object,
          updatedAt: BigInt(memory.updatedAt),
        },
      });

      await tx.memoryEntry.deleteMany({ where: { agentId: memory.agentId } });
      if (memory.entries.length > 0) {
        await tx.memoryEntry.createMany({
          data: memory.entries.map((e) => ({
            id: e.id,
            agentId: memory.agentId,
            tickId: e.tickId,
            type: e.type,
            content: e.content,
            parentEntryIds: e.parentEntryIds ?? [],
            createdAt: BigInt(e.createdAt),
          })),
        });
      }
    });
  }
}

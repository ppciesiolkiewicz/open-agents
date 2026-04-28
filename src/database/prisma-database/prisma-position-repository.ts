import { Prisma, type PrismaClient } from '@prisma/client';
import type { Position } from '../types';
import type { PositionRepository } from '../repositories/position-repository';
import { positionDomainToRow, positionRowToDomain } from './mappers';

export class PrismaPositionRepository implements PositionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private toCreateData(pos: Position) {
    const row = positionDomainToRow(pos);
    return { ...row, amount: row.amount as Prisma.InputJsonValue };
  }

  async insert(pos: Position): Promise<void> {
    await this.prisma.position.create({ data: this.toCreateData(pos) });
  }

  async findOpen(agentId: string, tokenAddress: string): Promise<Position | null> {
    const rows = await this.prisma.position.findMany({
      where: {
        agentId,
        closedAt: null,
        amount: { path: ['tokenAddress'], equals: tokenAddress },
      },
    });
    return rows[0] ? positionRowToDomain(rows[0]) : null;
  }

  async listByAgent(agentId: string): Promise<Position[]> {
    const rows = await this.prisma.position.findMany({
      where: { agentId },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map(positionRowToDomain);
  }

  async update(pos: Position): Promise<void> {
    await this.prisma.position.update({
      where: { id: pos.id },
      data: this.toCreateData(pos),
    });
  }
}

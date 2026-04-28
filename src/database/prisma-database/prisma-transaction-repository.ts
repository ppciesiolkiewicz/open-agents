import type { PrismaClient } from '@prisma/client';
import type { Transaction } from '../types';
import type { TransactionRepository } from '../repositories/transaction-repository';
import { txDomainToCreate, txRowToDomain } from './mappers';

export class PrismaTransactionRepository implements TransactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(tx: Transaction): Promise<void> {
    await this.prisma.transaction.create({ data: txDomainToCreate(tx) });
  }

  async findById(id: string): Promise<Transaction | null> {
    const row = await this.prisma.transaction.findUnique({ where: { id } });
    return row ? txRowToDomain(row) : null;
  }

  async listByAgent(agentId: string, opts?: { limit?: number }): Promise<Transaction[]> {
    if (typeof opts?.limit === 'number') {
      const rows = await this.prisma.transaction.findMany({
        where: { agentId },
        orderBy: { timestamp: 'desc' },
        take: opts.limit,
      });
      return rows.reverse().map(txRowToDomain);
    }
    const rows = await this.prisma.transaction.findMany({
      where: { agentId },
      orderBy: { timestamp: 'asc' },
    });
    return rows.map(txRowToDomain);
  }

  async updateStatus(
    id: string,
    patch: Pick<Transaction, 'status' | 'blockNumber' | 'hash'>,
  ): Promise<void> {
    await this.prisma.transaction.update({
      where: { id },
      data: {
        status: patch.status,
        blockNumber: patch.blockNumber === null ? null : BigInt(patch.blockNumber),
        hash: patch.hash,
      },
    });
  }
}

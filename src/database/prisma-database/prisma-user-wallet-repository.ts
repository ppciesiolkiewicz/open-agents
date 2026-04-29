import type { PrismaClient } from '@prisma/client';
import type { UserWallet } from '../types';
import type { UserWalletRepository } from '../repositories/user-wallet-repository';
import { userWalletRowToDomain } from './mappers';

export class PrismaUserWalletRepository implements UserWalletRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(uw: UserWallet): Promise<void> {
    await this.prisma.userWallet.create({
      data: {
        id: uw.id,
        userId: uw.userId,
        privyWalletId: uw.privyWalletId,
        walletAddress: uw.walletAddress,
        isPrimary: uw.isPrimary,
        createdAt: BigInt(uw.createdAt),
      },
    });
  }

  async findById(id: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findUnique({ where: { id } });
    return row ? userWalletRowToDomain(row) : null;
  }

  async findPrimaryByUser(userId: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findFirst({
      where: { userId, isPrimary: true },
    });
    return row ? userWalletRowToDomain(row) : null;
  }

  async listByUser(userId: string): Promise<UserWallet[]> {
    const rows = await this.prisma.userWallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(userWalletRowToDomain);
  }

  async findByPrivyWalletId(privyWalletId: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findUnique({ where: { privyWalletId } });
    return row ? userWalletRowToDomain(row) : null;
  }

  async findByWalletAddress(address: string): Promise<UserWallet | null> {
    const row = await this.prisma.userWallet.findFirst({
      where: { walletAddress: address },
    });
    return row ? userWalletRowToDomain(row) : null;
  }
}

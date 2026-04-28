import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { User } from '../types';
import type { UserRepository } from '../repositories/user-repository';
import { userRowToDomain } from './mappers';

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? userRowToDomain(row) : null;
  }

  async findByPrivyDid(privyDid: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { privyDid } });
    return row ? userRowToDomain(row) : null;
  }

  async findOrCreateByPrivyDid(
    privyDid: string,
    claims: { email?: string },
  ): Promise<User> {
    const row = await this.prisma.user.upsert({
      where: { privyDid },
      create: {
        id: randomUUID(),
        privyDid,
        email: claims.email ?? null,
        createdAt: BigInt(Date.now()),
      },
      update: {
        email: claims.email ?? null,
      },
    });
    return userRowToDomain(row);
  }
}

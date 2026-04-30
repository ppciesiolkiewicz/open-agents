import type { PrismaClient, Token as PrismaToken } from '@prisma/client';
import type { TokenRepository } from '../repositories/token-repository';
import type { Token } from '../types';

function mapToken(row: PrismaToken): Token {
  return {
    id: row.id,
    chainId: row.chainId,
    chain: row.chain,
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    logoUri: row.logoUri,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class PrismaTokenRepository implements TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByChainId(chainId: number): Promise<Token[]> {
    const rows = await this.prisma.token.findMany({
      where: { chainId },
      orderBy: { symbol: 'asc' },
    });
    return rows.map(mapToken);
  }
}

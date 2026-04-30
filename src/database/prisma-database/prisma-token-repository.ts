import type { PrismaClient, Prisma } from '@prisma/client';
import type { Token } from '../types';
import type { TokenRepository, TokenListPage } from '../repositories/token-repository';
import { tokenRowToDomain } from './mappers';

export class PrismaTokenRepository implements TokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByChainId(chainId: number): Promise<Token[]> {
    const rows = await this.prisma.token.findMany({
      where: { chainId },
      orderBy: { symbol: 'asc' },
    });
    return rows.map(tokenRowToDomain);
  }

  async findByAddress(address: string, chainId: number): Promise<Token | null> {
    const row = await this.prisma.token.findUnique({
      where: { address_chainId: { address: address.toLowerCase(), chainId } },
    });
    return row ? tokenRowToDomain(row) : null;
  }

  async findManyByAddresses(addresses: string[], chainId: number): Promise<Token[]> {
    if (addresses.length === 0) return [];
    const lowered = addresses.map((a) => a.toLowerCase());
    const rows = await this.prisma.token.findMany({
      where: { chainId, address: { in: lowered } },
    });
    return rows.map(tokenRowToDomain);
  }

  async findBySymbol(symbol: string, chainId: number): Promise<Token[]> {
    const rows = await this.prisma.token.findMany({
      where: { chainId, symbol },
    });
    return rows.map(tokenRowToDomain);
  }

  async list(opts: {
    chainId?: number;
    symbol?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<TokenListPage> {
    const limit = Math.min(opts.limit, 500);
    const where: Prisma.TokenWhereInput = {};
    if (opts.chainId !== undefined) where.chainId = opts.chainId;
    if (opts.symbol) where.symbol = opts.symbol;
    if (opts.search) {
      where.OR = [
        { symbol: { contains: opts.search, mode: 'insensitive' } },
        { name: { contains: opts.search, mode: 'insensitive' } },
      ];
    }

    const cursorId = opts.cursor ? Number(Buffer.from(opts.cursor, 'base64').toString('utf8')) : undefined;
    if (cursorId !== undefined && Number.isNaN(cursorId)) {
      throw new Error(`invalid cursor: ${opts.cursor}`);
    }

    const rows = await this.prisma.token.findMany({
      where,
      take: limit + 1,
      orderBy: { id: 'asc' },
      ...(cursorId !== undefined ? { skip: 1, cursor: { id: cursorId } } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    const nextCursor = hasMore && lastRow
      ? Buffer.from(String(lastRow.id), 'utf8').toString('base64')
      : null;

    return {
      tokens: page.map(tokenRowToDomain),
      nextCursor,
    };
  }
}

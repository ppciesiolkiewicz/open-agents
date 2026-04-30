import type { Token } from '../types';

export interface TokenListPage {
  tokens: Token[];
  nextCursor: string | null;
}

export interface TokenRepository {
  listByChainId(chainId: number): Promise<Token[]>;
  findByAddress(address: string, chainId: number): Promise<Token | null>;
  findManyByAddresses(addresses: string[], chainId: number): Promise<Token[]>;
  findBySymbol(symbol: string, chainId: number): Promise<Token[]>;
  list(opts: {
    chainId?: number;
    symbol?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<TokenListPage>;
}

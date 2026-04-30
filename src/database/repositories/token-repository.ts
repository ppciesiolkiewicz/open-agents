import type { Token } from '../types';

export interface TokenRepository {
  listByChainId(chainId: number): Promise<Token[]>;
}

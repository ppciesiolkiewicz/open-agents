export interface TokenInfo {
  address: `0x${string}`;
  decimals: number;
  symbol: string;
  coingeckoId: string;
}

export const TOKENS = {
  USDC: {
    address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    decimals: 6,
    symbol: 'USDC',
    coingeckoId: 'usd-coin',
  },
  UNI: {
    address: '0x8f187aA05619a017077f5308904739877ce9eA21',
    decimals: 18,
    symbol: 'UNI',
    coingeckoId: 'uniswap',
  },
} as const satisfies Record<string, TokenInfo>;

export type TokenSymbol = keyof typeof TOKENS;

export const ZEROG_NATIVE_TOKEN = {
  symbol: 'OG',
  decimals: 18,
  coingeckoId: 'zero-gravity',
} as const;

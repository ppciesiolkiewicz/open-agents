export interface TokenInfo {
  address: `0x${string}`;
  decimals: number;
  symbol: string;
  coingeckoId: string;
}

export const USDC_ON_UNICHAIN = {
  address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  decimals: 6,
  symbol: 'USDC',
  coingeckoId: 'usd-coin',
} as const satisfies TokenInfo;

export const UNI_ON_UNICHAIN = {
  address: '0x8f187aA05619a017077f5308904739877ce9eA21',
  decimals: 18,
  symbol: 'UNI',
  coingeckoId: 'uniswap',
} as const satisfies TokenInfo;

export const WBTC_ON_UNICHAIN = {
  address: '0x0555e30da8f98308edb960aa94c0db47230d2b9c' as `0x${string}`,
  decimals: 8,
  symbol: 'WBTC',
  coingeckoId: 'wrapped-bitcoin',
} as const satisfies TokenInfo;

export const ZEROG_NATIVE_TOKEN = {
  symbol: 'OG',
  decimals: 18,
  coingeckoId: 'zero-gravity',
} as const;

export const USDCE_ON_ZEROG = {
  address: '0x1f3aa82227281ca364bfb3d253b0f1af1da6473e' as `0x${string}`,
  decimals: 6,
  symbol: 'USDC.e',
  coingeckoId: 'usd-coin',
} as const;

export const W0G_ON_ZEROG = {
  address: '0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c' as `0x${string}`,
  decimals: 18,
  symbol: 'W0G',
} as const;

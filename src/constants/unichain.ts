export interface UnichainConfig {
  chainId: 130;
  nativeSymbol: 'ETH';
}

export const UNICHAIN: UnichainConfig = {
  chainId: 130,
  nativeSymbol: 'ETH',
};

export function resolveUnichainRpcUrl(env: {
  UNICHAIN_RPC_URL?: string;
  ALCHEMY_API_KEY: string;
}): string {
  return env.UNICHAIN_RPC_URL ?? `https://unichain-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
}

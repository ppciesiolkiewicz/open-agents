export interface ZeroGNetwork {
  chainId: number;
  rpcUrl: string;
}

export const ZEROG_NETWORKS = {
  mainnet: { chainId: 16661, rpcUrl: 'https://evmrpc.0g.ai' },
  testnet: { chainId: 16602, rpcUrl: 'https://evmrpc-testnet.0g.ai' },
} as const satisfies Record<'mainnet' | 'testnet', ZeroGNetwork>;

export type ZeroGNetworkName = keyof typeof ZEROG_NETWORKS;

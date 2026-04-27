import {
  createPublicClient,
  http,
  type PublicClient,
  type Hex,
} from 'viem';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl, UNISWAP_V4_UNICHAIN } from '../constants';
import { computePoolId } from './pool-key-builder';
import type { PoolKey, Slot0 } from './types';

const STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const;

export interface PoolStateReaderEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class PoolStateReader {
  private readonly publicClient: PublicClient;

  constructor(env: PoolStateReaderEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
  }

  async readSlot0(key: PoolKey): Promise<Slot0> {
    const id = computePoolId(key);
    const [sqrtPriceX96, tick, protocolFee, lpFee] = await this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.stateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [id as Hex],
    });
    return { sqrtPriceX96, tick, protocolFee, lpFee };
  }

  async readLiquidity(key: PoolKey): Promise<bigint> {
    const id = computePoolId(key);
    return this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.stateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [id as Hex],
    });
  }
}

import {
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl, UNISWAP_V4_UNICHAIN } from '../constants';
import { buildPoolKey } from './pool-key-builder';
import type { FeeTier, Quote } from './types';

const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export interface SwapQuoterEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class SwapQuoter {
  private readonly publicClient: PublicClient;

  constructor(env: SwapQuoterEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
  }

  async quoteExactInputSingle(args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    feeTier: FeeTier;
  }): Promise<Quote> {
    const poolKey = buildPoolKey(args.tokenIn, args.tokenOut, args.feeTier);
    const tokenInLower = args.tokenIn.toLowerCase();
    const zeroForOne = poolKey.currency0.toLowerCase() === tokenInLower;

    const [amountOut] = await this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.v4Quoter as `0x${string}`,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: {
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            fee: poolKey.fee,
            tickSpacing: poolKey.tickSpacing,
            hooks: poolKey.hooks,
          },
          zeroForOne,
          exactAmount: args.amountIn,
          hookData: '0x',
        },
      ],
    });

    return {
      amountIn: args.amountIn,
      amountOut,
      feeTier: args.feeTier,
    };
  }
}

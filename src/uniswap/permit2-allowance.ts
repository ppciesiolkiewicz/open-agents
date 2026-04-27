import {
  createPublicClient,
  http,
  encodeFunctionData,
  erc20Abi,
  type PublicClient,
  type Hex,
} from 'viem';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl, UNISWAP_V4_UNICHAIN } from '../constants';

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const FAR_FUTURE_EXPIRATION = 7_258_118_400; // 2200-01-01

const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export interface AllowanceReaderEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class Permit2Allowance {
  private readonly publicClient: PublicClient;

  constructor(env: AllowanceReaderEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
  }

  async readErc20ToPermit2(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`],
    });
  }

  async readPermit2ToRouter(
    token: `0x${string}`,
    owner: `0x${string}`,
  ): Promise<{ amount: bigint; expiration: number; nonce: number }> {
    const [amount, expiration, nonce] = await this.publicClient.readContract({
      address: UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, token, UNISWAP_V4_UNICHAIN.universalRouter as `0x${string}`],
    });
    return { amount, expiration, nonce };
  }

  buildErc20ApprovePermit2Calldata(): Hex {
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`, MAX_UINT256],
    });
  }

  buildPermit2ApproveRouterCalldata(token: `0x${string}`): Hex {
    return encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [
        token,
        UNISWAP_V4_UNICHAIN.universalRouter as `0x${string}`,
        MAX_UINT160,
        FAR_FUTURE_EXPIRATION,
      ],
    });
  }
}

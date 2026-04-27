import {
  createPublicClient,
  http,
  encodeFunctionData,
  type PublicClient,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { unichain } from 'viem/chains';
import {
  resolveUnichainRpcUrl,
  UNISWAP_V4_UNICHAIN,
  SWAP_DEADLINE_BUFFER_SECONDS,
} from '../constants';
import type { Wallet } from '../wallet/wallet';
import { buildPoolKey } from './pool-key-builder';
import { buildUniversalRouterV4Swap } from './v4-actions';
import { Permit2Allowance } from './permit2-allowance';
import type { SwapParams } from './types';

const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const ALLOWANCE_REFRESH_THRESHOLD = (1n << 200n);  // refresh well before MaxUint160 hits

export interface SwapExecutorEnv {
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class SwapExecutor {
  private readonly publicClient: PublicClient;
  private readonly allowance: Permit2Allowance;

  constructor(env: SwapExecutorEnv) {
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
    this.allowance = new Permit2Allowance(env);
  }

  /**
   * Executes a single-pool exact-input v4 swap. Auto-approves Permit2 + UniversalRouter
   * if needed. Returns the swap's TransactionReceipt + any approval receipts (so the
   * caller can record them as Transactions too).
   */
  async executeSwap(params: SwapParams, wallet: Wallet): Promise<{
    swapReceipt: TransactionReceipt;
    approvalReceipts: TransactionReceipt[];
  }> {
    const owner = wallet.getAddress();
    const approvalReceipts: TransactionReceipt[] = [];

    // 1. Ensure ERC20 → Permit2 allowance.
    const erc20Allowance = await this.allowance.readErc20ToPermit2(params.tokenIn, owner);
    if (erc20Allowance < params.amountIn) {
      const receipt = await wallet.signAndSendTransaction({
        to: params.tokenIn,
        data: this.allowance.buildErc20ApprovePermit2Calldata(),
      });
      approvalReceipts.push(receipt);
    }

    // 2. Ensure Permit2 → UniversalRouter allowance for this token.
    const permit2Allowance = await this.allowance.readPermit2ToRouter(params.tokenIn, owner);
    const nowSec = Math.floor(Date.now() / 1000);
    const needsRefresh =
      permit2Allowance.amount < ALLOWANCE_REFRESH_THRESHOLD ||
      permit2Allowance.expiration <= nowSec + SWAP_DEADLINE_BUFFER_SECONDS;
    if (needsRefresh) {
      const receipt = await wallet.signAndSendTransaction({
        to: UNISWAP_V4_UNICHAIN.permit2 as `0x${string}`,
        data: this.allowance.buildPermit2ApproveRouterCalldata(params.tokenIn),
      });
      approvalReceipts.push(receipt);
    }

    // 3. Build UniversalRouter v4 swap calldata.
    const poolKey = buildPoolKey(params.tokenIn, params.tokenOut, params.feeTier);
    const tokenInLower = params.tokenIn.toLowerCase();
    const zeroForOne = poolKey.currency0.toLowerCase() === tokenInLower;
    const { commands, inputs } = buildUniversalRouterV4Swap({
      poolKey,
      zeroForOne,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      inputCurrency: params.tokenIn,
      outputCurrency: params.tokenOut,
    });
    const deadline = BigInt(nowSec + SWAP_DEADLINE_BUFFER_SECONDS);
    const data: Hex = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, inputs, deadline],
    });

    // 4. Send the swap tx.
    const swapReceipt = await wallet.signAndSendTransaction({
      to: UNISWAP_V4_UNICHAIN.universalRouter as `0x${string}`,
      data,
    });

    return { swapReceipt, approvalReceipts };
  }
}

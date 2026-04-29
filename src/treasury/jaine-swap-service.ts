import { ethers } from 'ethers';
import { USDCE_ON_ZEROG, W0G_ON_ZEROG, JAINE_SWAP_ROUTER_ADDRESS, JAINE_POOL_FEE } from '../constants/index.js';
import type { TreasuryWallet } from './treasury-wallet.js';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
];

const W0G_ABI = [
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
];


export interface SwapResult {
  swapTxHash: string;
  swapInputUsdceAmount: string;
  swapOutputW0gAmount: string;
  swapGasCostWei: string;
  unwrapTxHash: string;
  unwrapGasCostWei: string;
  unwrappedOgAmount: string;
}

export class JaineSwapService {
  constructor(private readonly treasuryWallet: TreasuryWallet) {}

  async swapUsdceToNativeOg(usdceAmount: bigint): Promise<SwapResult> {
    const signer = this.treasuryWallet.zerogSigner;
    const treasuryAddress = this.treasuryWallet.getAddress();

    const usdce = new ethers.Contract(USDCE_ON_ZEROG.address, ERC20_ABI, signer);
    const w0g = new ethers.Contract(W0G_ON_ZEROG.address, W0G_ABI, signer);
    const router = new ethers.Contract(JAINE_SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, signer);

    const usdceAllowance = usdce.allowance as (owner: string, spender: string) => Promise<bigint>;
    const usdceApprove = usdce.approve as (spender: string, amount: bigint) => Promise<ethers.ContractTransactionResponse>;
    const routerExactInputSingle = router.exactInputSingle as (params: object) => Promise<ethers.ContractTransactionResponse>;
    const w0gBalanceOf = w0g.balanceOf as (address: string) => Promise<bigint>;
    const w0gWithdraw = w0g.withdraw as (wad: bigint) => Promise<ethers.ContractTransactionResponse>;

    const allowance: bigint = await usdceAllowance(treasuryAddress, JAINE_SWAP_ROUTER_ADDRESS);
    if (allowance < usdceAmount) {
      const approveTx = await usdceApprove(JAINE_SWAP_ROUTER_ADDRESS, usdceAmount);
      await approveTx.wait();
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    // amountOutMinimum=0: no slippage guard for v1 — cross-token price ratio not available without an oracle
    const amountOutMinimum = 0n;

    const w0gBalanceBefore: bigint = await w0gBalanceOf(treasuryAddress);

    const swapTx = await routerExactInputSingle({
      tokenIn: USDCE_ON_ZEROG.address,
      tokenOut: W0G_ON_ZEROG.address,
      fee: JAINE_POOL_FEE,
      recipient: treasuryAddress,
      deadline,
      amountIn: usdceAmount,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    });
    const swapReceipt = await swapTx.wait();
    if (!swapReceipt) throw new Error('JaineSwapService: swap tx no receipt');

    const swapGasCostWei = swapReceipt.gasUsed * swapReceipt.gasPrice;
    const w0gBalanceAfter: bigint = await w0gBalanceOf(treasuryAddress);
    const swapOutputAmount = w0gBalanceAfter - w0gBalanceBefore;

    const unwrapTx = await w0gWithdraw(w0gBalanceAfter);
    const unwrapReceipt = await unwrapTx.wait();
    if (!unwrapReceipt) throw new Error('JaineSwapService: unwrap tx no receipt');

    const unwrapGasCostWei = unwrapReceipt.gasUsed * unwrapReceipt.gasPrice;

    return {
      swapTxHash: swapReceipt.hash,
      swapInputUsdceAmount: usdceAmount.toString(),
      swapOutputW0gAmount: swapOutputAmount.toString(),
      swapGasCostWei: swapGasCostWei.toString(),
      unwrapTxHash: unwrapReceipt.hash,
      unwrapGasCostWei: unwrapGasCostWei.toString(),
      unwrappedOgAmount: w0gBalanceAfter.toString(),
    };
  }
}

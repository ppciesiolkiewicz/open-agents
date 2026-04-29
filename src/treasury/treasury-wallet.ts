import { createPublicClient, createWalletClient, http, erc20Abi, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { unichain } from 'viem/chains';
import { ethers } from 'ethers';
import type { Env } from '../config/env.js';
import { TOKENS, USDCE_ON_ZEROG, ZEROG_NETWORKS } from '../constants/index.js';
import { resolveUnichainRpcUrl } from '../constants/unichain.js';

export class TreasuryWallet {
  private readonly account: PrivateKeyAccount;
  readonly unichainPublicClient: PublicClient;
  readonly unichainWalletClient: WalletClient;
  readonly zerogProvider: ethers.JsonRpcProvider;
  readonly zerogSigner: ethers.Wallet;
  private readonly zerogNetwork: { rpcUrl: string; chainId: number };

  constructor(env: Env) {
    this.account = privateKeyToAccount(env.TREASURY_WALLET_PRIVATE_KEY as `0x${string}`);
    this.zerogNetwork = ZEROG_NETWORKS[env.ZEROG_NETWORK];

    this.unichainPublicClient = createPublicClient({
      chain: unichain,
      transport: http(resolveUnichainRpcUrl(env)),
    }) as PublicClient;
    this.unichainWalletClient = createWalletClient({
      account: this.account,
      chain: unichain,
      transport: http(resolveUnichainRpcUrl(env)),
    }) as WalletClient;

    this.zerogProvider = new ethers.JsonRpcProvider(this.zerogNetwork.rpcUrl);
    this.zerogSigner = new ethers.Wallet(env.TREASURY_WALLET_PRIVATE_KEY, this.zerogProvider);
  }

  getAddress(): `0x${string}` {
    return this.account.address;
  }

  async getUnichainUsdcBalance(): Promise<bigint> {
    return this.unichainPublicClient.readContract({
      address: TOKENS.USDC.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.account.address],
    });
  }

  async getZerogUsdceBalance(): Promise<bigint> {
    const usdce = new ethers.Contract(
      USDCE_ON_ZEROG.address,
      ['function balanceOf(address) view returns (uint256)'],
      this.zerogProvider,
    );
    const balanceOf = usdce.balanceOf as (address: string) => Promise<bigint>;
    return balanceOf(this.account.address);
  }

  async getZerogNativeBalance(): Promise<bigint> {
    return this.zerogProvider.getBalance(this.account.address).then(BigInt);
  }

  async sendNativeOg(to: string, amount: bigint): Promise<{ txHash: string; gasCostWei: bigint }> {
    const tx = await this.zerogSigner.sendTransaction({ to, value: amount });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('sendNativeOg: no receipt');
    const gasCostWei = receipt.gasUsed * receipt.gasPrice;
    return { txHash: receipt.hash, gasCostWei };
  }
}

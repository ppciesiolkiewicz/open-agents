import type { PrivyClient } from '@privy-io/server-auth';
import type { PublicClient } from 'viem';
import { erc20Abi } from 'viem';
import type { Wallet } from '../wallet';
import type { TxRequest, TransactionReceipt } from '../types';
import type { UserWallet } from '../../database/types';
import { UNICHAIN } from '../../constants';

export class PrivyServerWallet implements Wallet {
  constructor(
    private readonly privy: PrivyClient,
    private readonly userWallet: UserWallet,
    private readonly publicClient: PublicClient,
  ) {}

  getAddress(): `0x${string}` {
    return this.userWallet.walletAddress as `0x${string}`;
  }

  getNativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.getAddress() });
  }

  async getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.getAddress()],
    });
  }

  async signAndSendTransaction(req: TxRequest): Promise<TransactionReceipt> {
    const result = await this.privy.walletApi.ethereum.sendTransaction({
      walletId: this.userWallet.privyWalletId,
      caip2: `eip155:${UNICHAIN.chainId}`,
      transaction: {
        to: req.to,
        ...(req.data ? { data: req.data } : {}),
        ...(req.value !== undefined ? { value: `0x${req.value.toString(16)}` } : {}),
        ...(req.gas !== undefined ? { gasLimit: `0x${req.gas.toString(16)}` } : {}),
      },
    });
    return await this.publicClient.waitForTransactionReceipt({
      hash: result.hash as `0x${string}`,
    });
  }
}

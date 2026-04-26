import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { unichain } from 'viem/chains';
import { resolveUnichainRpcUrl } from '../../constants';
import type { Wallet } from '../wallet';
import type { TxRequest } from '../types';

export interface RealWalletEnv {
  WALLET_PRIVATE_KEY: string;
  ALCHEMY_API_KEY: string;
  UNICHAIN_RPC_URL?: string;
}

export class RealWallet implements Wallet {
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(env: RealWalletEnv) {
    this.account = privateKeyToAccount(env.WALLET_PRIVATE_KEY as `0x${string}`);
    const rpcUrl = resolveUnichainRpcUrl(env);
    this.publicClient = createPublicClient({ chain: unichain, transport: http(rpcUrl) }) as PublicClient;
    this.walletClient = createWalletClient({
      account: this.account,
      chain: unichain,
      transport: http(rpcUrl),
    }) as WalletClient;
  }

  getAddress(): `0x${string}` {
    return this.account.address;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.account.address],
    });
  }

  async signAndSendTransaction(req: TxRequest): Promise<TransactionReceipt> {
    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: unichain,
      to: req.to,
      data: req.data,
      value: req.value,
      gas: req.gas,
    });
    return this.publicClient.waitForTransactionReceipt({ hash });
  }
}

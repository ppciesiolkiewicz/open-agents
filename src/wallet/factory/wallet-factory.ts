import type { PrivyClient } from '@privy-io/server-auth';
import type { PublicClient } from 'viem';
import { Wallet as EthersWallet, type Signer, type JsonRpcProvider } from 'ethers';
import type { AgentConfig, UserWallet } from '../../database/types';
import type { TransactionRepository } from '../../database/repositories/transaction-repository';
import type { UserWalletRepository } from '../../database/repositories/user-wallet-repository';
import type { Wallet } from '../wallet';
import { RealWallet, type RealWalletEnv } from '../real/real-wallet';
import { DryRunWallet, type DryRunWalletEnv } from '../dry-run/dry-run-wallet';
import { PrivyServerWallet } from '../privy/privy-server-wallet';
import { PrivySigner } from '../privy/privy-signer';

export type WalletMode = 'pk' | 'privy' | 'privy_and_pk';

export interface ZeroGSignerHandle {
  signer: Signer;
  address: string;
}

export type WalletFactoryEnv = RealWalletEnv & DryRunWalletEnv;

export interface WalletFactoryDeps {
  env: WalletFactoryEnv;
  walletMode: WalletMode;
  transactions: TransactionRepository;
  userWallets: UserWalletRepository;
  privy: PrivyClient | null;
  publicClient: PublicClient;
  zerogProvider: JsonRpcProvider;
  zerogChainId: number;
}

export class WalletFactory {
  private readonly cache = new Map<string, Promise<Wallet>>();
  private envPkZeroGSigner: ZeroGSignerHandle | null = null;
  private readonly zerogSignerByUser = new Map<string, ZeroGSignerHandle>();

  constructor(private readonly deps: WalletFactoryDeps) {}

  async forAgent(agent: AgentConfig): Promise<Wallet> {
    const cached = this.cache.get(agent.id);
    if (cached) return cached;
    const promise = this.build(agent).catch((err) => {
      this.cache.delete(agent.id);
      throw err;
    });
    this.cache.set(agent.id, promise);
    return promise;
  }

  private async build(agent: AgentConfig): Promise<Wallet> {
    if (agent.dryRun) {
      return new DryRunWallet(agent, this.deps.transactions, this.deps.env);
    }
    switch (this.deps.walletMode) {
      case 'pk':
        return new RealWallet(this.deps.env);
      case 'privy':
      case 'privy_and_pk': {
        const privy = this.requirePrivy();
        const uw = await this.requirePrimaryUserWallet(agent);
        return new PrivyServerWallet(privy, uw, this.deps.publicClient);
      }
    }
  }

  private requirePrivy(): PrivyClient {
    if (!this.deps.privy) {
      throw new Error(
        `WalletFactory: walletMode=${this.deps.walletMode} requires a PrivyClient — set PRIVY_APP_ID and PRIVY_APP_SECRET`,
      );
    }
    return this.deps.privy;
  }

  private async requirePrimaryUserWallet(agent: AgentConfig): Promise<UserWallet> {
    const uw = await this.deps.userWallets.findPrimaryByUser(agent.userId);
    if (!uw) {
      throw new Error(
        `agent ${agent.id} (user ${agent.userId}) has no primary UserWallet — provision one via POST /users/me/wallets`,
      );
    }
    return uw;
  }

  async forZerogPayments(agent: AgentConfig): Promise<ZeroGSignerHandle> {
    switch (this.deps.walletMode) {
      case 'pk':
      case 'privy_and_pk':
        return this.envPkSigner();
      case 'privy':
        return this.privyZeroGSigner(agent);
    }
  }

  private envPkSigner(): ZeroGSignerHandle {
    if (this.envPkZeroGSigner) return this.envPkZeroGSigner;
    const wallet = new EthersWallet(this.deps.env.WALLET_PRIVATE_KEY, this.deps.zerogProvider);
    const handle: ZeroGSignerHandle = { signer: wallet, address: wallet.address };
    this.envPkZeroGSigner = handle;
    return handle;
  }

  private async privyZeroGSigner(agent: AgentConfig): Promise<ZeroGSignerHandle> {
    const cached = this.zerogSignerByUser.get(agent.userId);
    if (cached) return cached;
    const privy = this.requirePrivy();
    const uw = await this.requirePrimaryUserWallet(agent);
    const signer = new PrivySigner(
      privy,
      uw.privyWalletId,
      uw.walletAddress,
      this.deps.zerogChainId,
      this.deps.zerogProvider,
    );
    const handle: ZeroGSignerHandle = { signer, address: uw.walletAddress };
    this.zerogSignerByUser.set(agent.userId, handle);
    return handle;
  }
}

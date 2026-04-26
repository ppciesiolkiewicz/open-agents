import type { AgentConfig } from '../../database/types';
import type { TransactionRepository } from '../../database/repositories/transaction-repository';
import type { Wallet } from '../wallet';
import { RealWallet, type RealWalletEnv } from '../real/real-wallet';
import { DryRunWallet, type DryRunWalletEnv } from '../dry-run/dry-run-wallet';

export type WalletFactoryEnv = RealWalletEnv & DryRunWalletEnv;

export class WalletFactory {
  constructor(
    private readonly env: WalletFactoryEnv,
    private readonly transactions: TransactionRepository,
  ) {}

  forAgent(agent: AgentConfig): Wallet {
    if (agent.dryRun) {
      return new DryRunWallet(agent, this.transactions, this.env);
    }
    return new RealWallet(this.env);
  }
}

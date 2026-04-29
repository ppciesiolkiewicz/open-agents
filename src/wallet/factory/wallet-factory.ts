import type { AgentConfig } from '../../database/types';
import type { TransactionRepository } from '../../database/repositories/transaction-repository';
import type { Wallet } from '../wallet';
import { RealWallet, type RealWalletEnv } from '../real/real-wallet';
import { DryRunWallet, type DryRunWalletEnv } from '../dry-run/dry-run-wallet';

export type WalletFactoryEnv = RealWalletEnv & DryRunWalletEnv;

/**
 * Transitional: returns the env-key RealWallet for every agent regardless
 * of which user owns it. Per-user wallets via PrivyWalletFactory ship in
 * a follow-up cutover spec — the module exists and is tested under
 * `src/wallet/privy/` but is not wired into this factory yet.
 */
export class WalletFactory {
  // Cache wallets per agentId. The cached AgentConfig reference is from
  // the FIRST forAgent() call, so config edits (dryRun flip,
  // dryRunSeedBalances change) require a restart to take effect — fine
  // for v1 because the project convention is to clear the DB between
  // modes anyway.
  private readonly cache = new Map<string, Wallet>();

  constructor(
    private readonly env: WalletFactoryEnv,
    private readonly transactions: TransactionRepository,
  ) {}

  forAgent(agent: AgentConfig): Wallet {
    const cached = this.cache.get(agent.id);
    if (cached) return cached;
    const wallet = agent.dryRun
      ? new DryRunWallet(agent, this.transactions, this.env)
      : new RealWallet(this.env);
    this.cache.set(agent.id, wallet);
    return wallet;
  }
}

import { privateKeyToAccount } from 'viem/accounts';
import type { TransactionReceipt } from 'viem';
import type { Wallet } from '../wallet';
import type { TxRequest } from '../types';
import type { AgentConfig } from '../../database/types';
import type { TransactionRepository } from '../../database/repositories/transaction-repository';
import { generateDryRunHash } from './dry-run-hash';

const NATIVE_KEY = 'native';

// Default gas synthesis when a TxRequest doesn't supply estimates.
// UniswapService (slice 7) is expected to pass realistic values.
const DEFAULT_DRY_RUN_GAS = 200_000n;
const DEFAULT_DRY_RUN_GAS_PRICE_WEI = 1_000_000_000n;  // 1 gwei

export interface DryRunWalletEnv {
  WALLET_PRIVATE_KEY: string;
}

export class DryRunWallet implements Wallet {
  private readonly address: `0x${string}`;

  constructor(
    private readonly agent: AgentConfig,
    private readonly transactions: TransactionRepository,
    env: DryRunWalletEnv,
  ) {
    this.address = privateKeyToAccount(env.WALLET_PRIVATE_KEY as `0x${string}`).address;
  }

  getAddress(): `0x${string}` {
    return this.address;
  }

  async getNativeBalance(): Promise<bigint> {
    const seed = this.seed(NATIVE_KEY);
    const txs = await this.transactions.listByAgent(this.agent.id);
    let bal = seed;
    for (const tx of txs) {
      bal -= BigInt(tx.gasCostWei);
    }
    return bal;
  }

  async getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    const seed = this.seed(tokenAddress);
    const txs = await this.transactions.listByAgent(this.agent.id);
    let bal = seed;
    for (const tx of txs) {
      if (tx.tokenIn && tx.tokenIn.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()) {
        bal -= BigInt(tx.tokenIn.amountRaw);
      }
      if (tx.tokenOut && tx.tokenOut.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()) {
        bal += BigInt(tx.tokenOut.amountRaw);
      }
    }
    return bal;
  }

  async signAndSendTransaction(req: TxRequest): Promise<TransactionReceipt> {
    const hash = generateDryRunHash() as `0x${string}`;
    const gasUsed = req.gas ?? DEFAULT_DRY_RUN_GAS;
    const effectiveGasPrice = req.gasPriceWei ?? DEFAULT_DRY_RUN_GAS_PRICE_WEI;

    return {
      blockHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
      blockNumber: 0n,
      contractAddress: null,
      cumulativeGasUsed: gasUsed,
      effectiveGasPrice,
      from: this.address,
      gasUsed,
      logs: [],
      logsBloom: ('0x' + '0'.repeat(512)) as `0x${string}`,
      status: 'success',
      to: req.to,
      transactionHash: hash,
      transactionIndex: 0,
      type: 'eip1559',
    } as TransactionReceipt;
  }

  private seed(key: string): bigint {
    const raw = this.agent.dryRunSeedBalances?.[key.toLowerCase()]
      ?? this.agent.dryRunSeedBalances?.[key];
    return raw ? BigInt(raw) : 0n;
  }
}

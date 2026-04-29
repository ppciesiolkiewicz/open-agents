import { createPublicClient, webSocket, parseAbi } from 'viem';
import { unichain } from 'viem/chains';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { TOKENS, TREASURY_REDIS_QUEUE } from '../constants/index.js';
import type { TreasuryWallet } from './treasury-wallet.js';

export interface TreasuryTransferEvent {
  fromAddress: string;
  toAddress: string;
  amount: string;
  txHash: string;
  blockNumber: string;
}

export class TreasuryFundsWatcher {
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly env: Env,
    private readonly treasuryWallet: TreasuryWallet,
    private readonly redis: Redis,
  ) {}

  start(): void {
    const alchemyWsUrl = `wss://unichain-mainnet.g.alchemy.com/v2/${this.env.ALCHEMY_API_KEY}`;
    const client = createPublicClient({
      chain: unichain,
      transport: webSocket(alchemyWsUrl),
    });

    const treasuryAddress = this.treasuryWallet.getAddress().toLowerCase() as `0x${string}`;

    this.unwatch = client.watchContractEvent({
      address: TOKENS.USDC.address,
      abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
      eventName: 'Transfer',
      args: { to: treasuryAddress },
      onLogs: (logs) => {
        for (const log of logs) {
          const event: TreasuryTransferEvent = {
            fromAddress: log.args.from as string,
            toAddress: log.args.to as string,
            amount: (log.args.value as bigint).toString(),
            txHash: log.transactionHash ?? '',
            blockNumber: (log.blockNumber ?? 0n).toString(),
          };
          this.redis.lpush(TREASURY_REDIS_QUEUE, JSON.stringify(event)).catch((err) => {
            console.error('[TreasuryFundsWatcher] redis lpush error:', err);
          });
          console.log(`[TreasuryFundsWatcher] detected USDC transfer from ${event.fromAddress}, amount=${event.amount}`);
        }
      },
      onError: (err) => {
        console.error('[TreasuryFundsWatcher] watchContractEvent error:', err);
      },
    });

    console.log(`[TreasuryFundsWatcher] watching USDC transfers to ${treasuryAddress}`);
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    console.log('[TreasuryFundsWatcher] stopped');
  }
}

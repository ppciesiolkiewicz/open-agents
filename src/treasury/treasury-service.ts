import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import type { Redis } from 'ioredis';
import type { PrivyClient } from '@privy-io/server-auth';
import type { Env } from '../config/env.js';
import type { Database } from '../database/database.js';
import type { ZeroGPurchase } from '../database/types.js';
import { TREASURY_REDIS_QUEUE, TREASURY_SERVICE_FEE_BPS, ZEROG_NETWORKS } from '../constants/index.js';
import { ZeroGBrokerFactory } from '../ai/zerog-broker/zerog-broker-factory.js';
import { ZeroGBrokerService } from '../ai/zerog-broker/zerog-broker-service.js';
import { ZeroGBootstrapStore } from '../ai/zerog-broker/zerog-bootstrap-store.js';
import { PrivyZeroGSigner } from '../wallet/privy/privy-zerog-signer.js';
import type { TreasuryWallet } from './treasury-wallet.js';
import type { JaineSwapService } from './jaine-swap-service.js';
import type { TreasuryTransferEvent } from './treasury-funds-watcher.js';

const MIN_USDCE_FOR_SWAP = 10n * 1_000_000n;

export class TreasuryService {
  private running = false;

  constructor(
    private readonly env: Env,
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly treasuryWallet: TreasuryWallet,
    private readonly jaineSwap: JaineSwapService,
    private readonly privy: PrivyClient,
  ) {}

  start(): void {
    this.running = true;
    void this.consume();
    console.log('[TreasuryService] started, consuming from', TREASURY_REDIS_QUEUE);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.redis.brpop(TREASURY_REDIS_QUEUE, 5);
        if (!result) continue;
        const event: TreasuryTransferEvent = JSON.parse(result[1]);
        await this.processTransferEvent(event);
      } catch (err) {
        console.error('[TreasuryService] consume error:', err);
      }
    }
  }

  private async processTransferEvent(event: TreasuryTransferEvent): Promise<void> {
    const userWallet = await this.db.userWallets.findByWalletAddress(event.fromAddress);
    if (!userWallet) {
      console.log(`[TreasuryService] unknown sender ${event.fromAddress}, skipping`);
      return;
    }

    const duplicate = await this.db.zeroGPurchases.findByIncomingTxHash(event.txHash);
    if (duplicate) {
      console.log(`[TreasuryService] duplicate event for tx ${event.txHash}, skipping`);
      return;
    }

    const incomingAmount = BigInt(event.amount);
    const serviceFeeAmount = (incomingAmount * BigInt(TREASURY_SERVICE_FEE_BPS)) / 10000n;
    const swapInputAmount = incomingAmount - serviceFeeAmount;

    const now = Date.now();
    const purchase: ZeroGPurchase = {
      id: randomUUID(),
      userId: userWallet.userId,
      userWalletAddress: event.fromAddress,
      incomingTxHash: event.txHash,
      incomingUsdcAmount: incomingAmount.toString(),
      serviceFeeUsdcAmount: serviceFeeAmount.toString(),
      swapInputUsdcAmount: swapInputAmount.toString(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.zeroGPurchases.insert(purchase);

    try {
      await this.runPipeline(purchase, swapInputAmount, userWallet);
    } catch (err) {
      await this.db.zeroGPurchases.update(purchase.id, {
        status: 'failed',
        errorMessage: (err as Error).message,
      });
      console.error(`[TreasuryService] pipeline failed for ${purchase.id}:`, err);
    }
  }

  private async runPipeline(
    purchase: ZeroGPurchase,
    swapInputAmount: bigint,
    userWallet: { userId: string; walletAddress: string; privyWalletId: string },
  ): Promise<void> {
    const zerogNetwork = ZEROG_NETWORKS[this.env.ZEROG_NETWORK];

    const usdceBalance = await this.treasuryWallet.getZerogUsdceBalance();
    if (usdceBalance < swapInputAmount + MIN_USDCE_FOR_SWAP) {
      throw new Error(
        `Insufficient USDC.e on 0G chain: have ${usdceBalance}, need ${swapInputAmount + MIN_USDCE_FOR_SWAP}. Top up treasury wallet manually.`
      );
    }

    await this.db.zeroGPurchases.update(purchase.id, { status: 'swapping' });
    const swapResult = await this.jaineSwap.swapUsdceToNativeOg(swapInputAmount);
    await this.db.zeroGPurchases.update(purchase.id, {
      swapTxHash: swapResult.swapTxHash,
      swapInputUsdceAmount: swapResult.swapInputUsdceAmount,
      swapOutputW0gAmount: swapResult.swapOutputW0gAmount,
      swapGasCostWei: swapResult.swapGasCostWei,
      unwrapTxHash: swapResult.unwrapTxHash,
      unwrapGasCostWei: swapResult.unwrapGasCostWei,
      unwrappedOgAmount: swapResult.unwrappedOgAmount,
    });

    await this.db.zeroGPurchases.update(purchase.id, { status: 'sending' });
    const nativeOgAmount = BigInt(swapResult.unwrappedOgAmount);
    const gasReserve = ethers.parseEther('0.01');
    const sendAmount = nativeOgAmount > gasReserve ? nativeOgAmount - gasReserve : nativeOgAmount;
    const sendResult = await this.treasuryWallet.sendNativeOg(userWallet.walletAddress, sendAmount);
    await this.db.zeroGPurchases.update(purchase.id, {
      sendTxHash: sendResult.txHash,
      sendGasCostWei: sendResult.gasCostWei.toString(),
      ogAmountSentToUser: sendAmount.toString(),
    });

    await this.db.zeroGPurchases.update(purchase.id, { status: 'topping_up' });
    const provider = new ethers.JsonRpcProvider(zerogNetwork.rpcUrl);
    const userSigner = new PrivyZeroGSigner(
      this.privy,
      userWallet.privyWalletId,
      userWallet.walletAddress,
      zerogNetwork.chainId,
      provider,
    );

    const bootstrapStore = new ZeroGBootstrapStore(this.env.DB_DIR);
    const state = await bootstrapStore.load();
    if (state) {
      const broker = await ZeroGBrokerFactory.createBrokerFromSigner(userSigner, zerogNetwork.rpcUrl);
      const brokerService = new ZeroGBrokerService(broker);
      await brokerService.ensureLedgerBalance({ minOG: 0.5, depositOG: 3 });
      await brokerService.fundAndAcknowledge({
        providerAddress: state.providerAddress,
        ledgerInitialOG: 3,
        transferOG: 1,
        topUpThresholdOG: 0.3,
      });
      await this.db.zeroGPurchases.update(purchase.id, {
        ledgerTopUpTxHash: 'completed',
        ledgerTopUpGasCostWei: '0',
      });
    }

    await this.db.zeroGPurchases.update(purchase.id, { status: 'completed' });
    console.log(`[TreasuryService] purchase ${purchase.id} completed for user ${userWallet.userId}`);
  }
}

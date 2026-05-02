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
import { PrivySigner } from '../wallet/privy/privy-signer.js';
import type { TreasuryWallet } from './treasury-wallet.js';
import type { JaineSwapService } from './jaine-swap-service.js';
import type { TreasuryTransferEvent } from './treasury-funds-watcher.js';


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
        console.log(
          `[TreasuryService] event popped from=${event.fromAddress} amount=${event.amount} txHash=${event.txHash}`,
        );
        await this.processTransferEvent(event);
      } catch (err) {
        console.error('[TreasuryService] consume error:', err);
      }
    }
  }

  private async processTransferEvent(event: TreasuryTransferEvent): Promise<void> {
    const userWallet = await this.db.userWallets.findByWalletAddress(event.fromAddress);
    if (!userWallet) {
      console.log(`[TreasuryService] event=${event.txHash} unknown sender ${event.fromAddress}, skipping`);
      return;
    }

    const duplicate = await this.db.zeroGPurchases.findByIncomingTxHash(event.txHash);
    if (duplicate) {
      console.log(
        `[TreasuryService] event=${event.txHash} duplicate of purchase=${duplicate.id}, skipping`,
      );
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
    console.log(
      `[TreasuryService] purchase=${purchase.id} created userId=${userWallet.userId} from=${event.fromAddress} incoming=${incomingAmount} fee=${serviceFeeAmount} swapInput=${swapInputAmount}`,
    );

    const startedAt = Date.now();
    try {
      await this.runPipeline(purchase, swapInputAmount, userWallet);
      console.log(
        `[TreasuryService] purchase=${purchase.id} completed userId=${userWallet.userId} elapsedMs=${Date.now() - startedAt}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      await this.db.zeroGPurchases.update(purchase.id, {
        status: 'failed',
        errorMessage: message,
      });
      console.error(
        `[TreasuryService] purchase=${purchase.id} failed elapsedMs=${Date.now() - startedAt} error=${message}`,
        err,
      );
    }
  }

  private async runPipeline(
    purchase: ZeroGPurchase,
    swapInputAmount: bigint,
    userWallet: { userId: string; walletAddress: string; privyWalletId: string },
  ): Promise<void> {
    const tag = `[TreasuryService] purchase=${purchase.id}`;
    const zerogNetwork = ZEROG_NETWORKS[this.env.ZEROG_NETWORK];

    const usdceBalance = await this.treasuryWallet.getZerogUsdceBalance();
    console.log(`${tag} precheck treasury USDC.e have=${usdceBalance} need=${swapInputAmount}`);
    if (usdceBalance < swapInputAmount) {
      throw new Error(
        `Insufficient USDC.e on 0G chain: have ${usdceBalance}, need ${swapInputAmount}. Top up treasury wallet manually.`
      );
    }

    await this.db.zeroGPurchases.update(purchase.id, { status: 'swapping' });
    const swapStartedAt = Date.now();
    console.log(`${tag} stage=swap start input=${swapInputAmount}`);
    const swapResult = await this.jaineSwap.swapUsdceToNativeOg(swapInputAmount);
    console.log(
      `${tag} stage=swap done elapsedMs=${Date.now() - swapStartedAt} swapTxHash=${swapResult.swapTxHash} unwrapTxHash=${swapResult.unwrapTxHash} outputW0g=${swapResult.swapOutputW0gAmount} unwrappedOg=${swapResult.unwrappedOgAmount}`,
    );
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
    const sendStartedAt = Date.now();
    console.log(
      `${tag} stage=send start to=${userWallet.walletAddress} amount=${sendAmount} gasReserve=${gasReserve}`,
    );
    const sendResult = await this.treasuryWallet.sendNativeOg(userWallet.walletAddress, sendAmount);
    console.log(
      `${tag} stage=send done elapsedMs=${Date.now() - sendStartedAt} txHash=${sendResult.txHash} gasCostWei=${sendResult.gasCostWei}`,
    );
    await this.db.zeroGPurchases.update(purchase.id, {
      sendTxHash: sendResult.txHash,
      sendGasCostWei: sendResult.gasCostWei.toString(),
      ogAmountSentToUser: sendAmount.toString(),
    });

    await this.db.zeroGPurchases.update(purchase.id, { status: 'topping_up' });
    const topupStartedAt = Date.now();
    const provider = new ethers.JsonRpcProvider(zerogNetwork.rpcUrl);
    const userSigner = new PrivySigner(
      this.privy,
      userWallet.privyWalletId,
      userWallet.walletAddress,
      zerogNetwork.chainId,
      provider,
    );

    const providerAddress = this.env.ZEROG_PROVIDER_ADDRESS;
    if (!providerAddress) {
      throw new Error('ZEROG_PROVIDER_ADDRESS is required for the purchase flow — set it in .env');
    }

    // 0G broker hard-minimums: depositOG >= 3, transferOG >= 1.
    const userOgBalance = await provider.getBalance(userWallet.walletAddress);
    const minRequired = ethers.parseEther('4.05'); // 3 deposit + 1 transfer + ~0.05 gas
    console.log(
      `${tag} stage=topup precheck user OG have=${ethers.formatEther(userOgBalance)} need>=${ethers.formatEther(minRequired)} provider=${providerAddress}`,
    );
    if (userOgBalance < minRequired) {
      throw new Error(
        `User OG balance ${ethers.formatEther(userOgBalance)} below broker minimum ${ethers.formatEther(minRequired)} OG (3 deposit + 1 transfer + gas). Deposit was too small.`,
      );
    }
    console.log(`${tag} stage=topup creating broker for user=${userWallet.walletAddress}`);
    const broker = await ZeroGBrokerFactory.createBrokerFromSigner(userSigner);
    const brokerService = new ZeroGBrokerService(broker);
    console.log(`${tag} stage=topup ensureLedgerBalance start minOG=0.5 depositOG=3`);
    await brokerService.ensureLedgerBalance({ minOG: 0.5, depositOG: 3 });
    console.log(`${tag} stage=topup ensureLedgerBalance done`);
    console.log(
      `${tag} stage=topup fundAndAcknowledge start ledgerInitialOG=3 transferOG=1 topUpThresholdOG=0.3`,
    );
    await brokerService.fundAndAcknowledge({
      providerAddress: providerAddress as `0x${string}`,
      ledgerInitialOG: 3,
      transferOG: 1,
      topUpThresholdOG: 0.3,
    });
    console.log(
      `${tag} stage=topup fundAndAcknowledge done elapsedMs=${Date.now() - topupStartedAt}`,
    );
    await this.db.zeroGPurchases.update(purchase.id, {
      ledgerTopUpTxHash: 'completed',
      ledgerTopUpGasCostWei: '0',
    });

    await this.db.zeroGPurchases.update(purchase.id, { status: 'completed' });
  }
}

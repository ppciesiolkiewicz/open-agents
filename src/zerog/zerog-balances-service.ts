import { ethers } from 'ethers';
import type { ZeroGBrokerService } from '../ai/zerog-broker/zerog-broker-service';

export interface ProviderBalance {
  address: `0x${string}`;
  model: string;
  serviceType: string;
  balanceRaw: string;
  balanceFormatted: string;
}

export interface LedgerBalance {
  totalRaw: string;
  totalFormatted: string;
  availableRaw: string;
  availableFormatted: string;
  lockedRaw: string;
  lockedFormatted: string;
}

export interface ZeroGBalancesSnapshot {
  providers: ProviderBalance[];
  ledger: LedgerBalance;
}

export class ZeroGBalancesService {
  constructor(private readonly brokerService: ZeroGBrokerService) {}

  async fetchBalancesSnapshot(): Promise<ZeroGBalancesSnapshot> {
    const [providers, ledger] = await Promise.all([
      this.brokerService.listProviders(),
      this.brokerService.readLedgerSnapshot(),
    ]);

    const providerBalances: ProviderBalance[] = providers.map((p) => ({
      address: p.providerAddress,
      model: p.model,
      serviceType: p.serviceType,
      balanceRaw: (p.subAccountBalanceWei ?? 0n).toString(),
      balanceFormatted: ethers.formatEther(p.subAccountBalanceWei ?? 0n),
    }));

    return {
      providers: providerBalances,
      ledger: {
        totalRaw: ledger.totalWei.toString(),
        totalFormatted: ethers.formatEther(ledger.totalWei),
        availableRaw: ledger.availableWei.toString(),
        availableFormatted: ethers.formatEther(ledger.availableWei),
        lockedRaw: ledger.lockedWei.toString(),
        lockedFormatted: ethers.formatEther(ledger.lockedWei),
      },
    };
  }
}

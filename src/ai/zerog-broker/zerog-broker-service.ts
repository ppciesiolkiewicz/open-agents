import { ethers } from 'ethers';
import type { ProviderListing } from './types';
import type { ZeroGBroker } from './zerog-broker-factory';

export class ZeroGBrokerService {
  constructor(private readonly broker: ZeroGBroker) {}

  /**
   * Lists every provider exposed by the network. Best-effort enrichment with
   * sub-account balance; returns undefined for that field if the SDK does not
   * expose it cleanly.
   */
  async listProviders(): Promise<ProviderListing[]> {
    const services = (await this.broker.inference.listService()) as unknown as Array<Record<string, unknown>>;
    const out: ProviderListing[] = [];
    for (const svc of services) {
      const providerAddress = pickAddress(svc, ['provider', 'providerAddress', 'address']);
      const serviceUrl = pickString(svc, ['url', 'endpoint', 'serviceUrl']);
      const model = pickString(svc, ['model']);
      if (!providerAddress || !serviceUrl || !model) continue;

      out.push({
        providerAddress,
        serviceUrl,
        model,
        inputPricePerToken: pickBigInt(svc, ['inputPrice', 'inputPricePerToken']),
        outputPricePerToken: pickBigInt(svc, ['outputPrice', 'outputPricePerToken']),
        subAccountBalanceWei: undefined,  // see balance note below
      });
    }
    return out;
  }

  /**
   * Funds the ledger if it does not already exist (ledger creation requires
   * 3 OG minimum), transfers `transferOG` to the provider sub-account
   * (1 OG minimum per provider), acknowledges the provider, then returns
   * the cached service metadata.
   */
  async fundAndAcknowledge(args: {
    providerAddress: `0x${string}`;
    ledgerInitialOG: number;   // 3 OG minimum
    transferOG: number;        // 1 OG minimum
  }): Promise<{ serviceUrl: string; model: string }> {
    if (args.ledgerInitialOG < 3) {
      throw new Error('ledgerInitialOG must be >= 3 (0G ledger minimum)');
    }
    if (args.transferOG < 1) {
      throw new Error('transferOG must be >= 1 (per-provider minimum)');
    }

    try {
      await this.broker.ledger.addLedger(args.ledgerInitialOG);
    } catch (err) {
      // addLedger throws if the ledger already exists; that's expected on top-up runs.
      const msg = (err as Error).message ?? '';
      if (!/already|exist/i.test(msg)) throw err;
    }

    await this.broker.ledger.transferFund(
      args.providerAddress,
      'inference',
      ethers.parseEther(String(args.transferOG)),
    );

    await this.broker.inference.acknowledgeProviderSigner(args.providerAddress);

    const metadata = await this.broker.inference.getServiceMetadata(args.providerAddress);
    const serviceUrl = (metadata as { endpoint?: string }).endpoint ?? '';
    const model = (metadata as { model?: string }).model ?? '';
    if (!serviceUrl || !model) {
      throw new Error(`getServiceMetadata returned unexpected shape: ${JSON.stringify(metadata)}`);
    }
    return { serviceUrl, model };
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickAddress(obj: Record<string, unknown>, keys: string[]): `0x${string}` | undefined {
  const s = pickString(obj, keys);
  if (s && /^0x[0-9a-fA-F]{40}$/.test(s)) return s as `0x${string}`;
  return undefined;
}

function pickBigInt(obj: Record<string, unknown>, keys: string[]): bigint | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(v);
    if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  }
  return undefined;
}

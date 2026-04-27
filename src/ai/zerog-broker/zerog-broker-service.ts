import { ethers } from 'ethers';
import type { ProviderListing } from './types';
import type { ZeroGBroker } from './zerog-broker-factory';

const CHAT_SERVICE_TYPES = new Set(['chatbot', 'inference', 'chat', 'llm']);

export class ZeroGBrokerService {
  constructor(private readonly broker: ZeroGBroker) {}

  /**
   * Lists chat/inference providers only (drops image and audio services).
   * Optionally filtered by ZEROG_MODEL_FILTER env var (case-insensitive substring on model name).
   * Populates subAccountBalanceWei from broker.ledger.getProvidersWithBalance.
   */
  async listProviders(): Promise<ProviderListing[]> {
    const services = (await this.broker.inference.listService()) as unknown as Array<Record<string, unknown>>;

    const modelFilter = process.env.ZEROG_MODEL_FILTER?.toLowerCase();

    const balanceMap = await buildBalanceMap(this.broker);

    const out: ProviderListing[] = [];
    for (const svc of services) {
      const serviceType = pickString(svc, ['serviceType']);
      if (!isChatService(serviceType)) continue;

      const providerAddress = pickAddress(svc, ['provider', 'providerAddress', 'address']);
      const serviceUrl = pickString(svc, ['url', 'endpoint', 'serviceUrl']);
      const model = pickString(svc, ['model']);
      if (!providerAddress || !serviceUrl || !model) continue;

      if (modelFilter && !model.toLowerCase().includes(modelFilter)) continue;

      out.push({
        providerAddress,
        serviceUrl,
        model,
        inputPricePerToken: pickBigInt(svc, ['inputPrice', 'inputPricePerToken']),
        outputPricePerToken: pickBigInt(svc, ['outputPrice', 'outputPricePerToken']),
        subAccountBalanceWei: balanceMap.get(providerAddress.toLowerCase()) ?? 0n,
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

function isChatService(serviceType: string | undefined): boolean {
  if (!serviceType) return false;
  const t = serviceType.toLowerCase();
  return CHAT_SERVICE_TYPES.has(t) || t.includes('chat') || t.includes('completion') || t.includes('inference') || t.includes('llm');
}

async function buildBalanceMap(broker: ZeroGBroker): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>();
  try {
    const entries = await broker.ledger.getProvidersWithBalance('inference');
    for (const [addr, balance] of entries) {
      map.set(addr.toLowerCase(), balance);
    }
  } catch {
    // Ledger may not exist yet (no addLedger called); return empty map.
  }
  return map;
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

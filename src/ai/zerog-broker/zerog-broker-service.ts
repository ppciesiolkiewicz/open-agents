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
   * Reads the current sub-account balance for a provider (best-effort; returns
   * 0n if the user has no ledger yet or the lookup fails).
   */
  async readSubAccountBalanceWei(providerAddress: `0x${string}`): Promise<bigint> {
    const map = await buildBalanceMap(this.broker);
    return map.get(providerAddress.toLowerCase()) ?? 0n;
  }

  /**
   * Reads the main ledger's available balance (the part NOT locked into any
   * sub-account, available to transfer or to be drawn down by SDK
   * auto-funding). Returns 0n if no ledger exists yet.
   */
  async readLedgerAvailableBalanceWei(): Promise<bigint> {
    try {
      const ledger = await this.broker.ledger.getLedger();
      return ledger.availableBalance;
    } catch {
      return 0n;
    }
  }

  /**
   * Ensure the main ledger has at least `minOG` available. If below, deposit
   * `depositOG` (or addLedger if no ledger yet). Used to keep the SDK's
   * background auto-funding from warning when the sub-account is fine but
   * the main ledger is drained.
   */
  async ensureLedgerBalance(args: {
    minOG: number;
    depositOG: number;     // 3 OG minimum (for addLedger)
  }): Promise<{ deposited: boolean; balanceBeforeWei: bigint; balanceAfterWei: bigint }> {
    if (args.depositOG < 3) {
      throw new Error('depositOG must be >= 3 (0G ledger minimum)');
    }
    const minWei = ethers.parseEther(String(args.minOG));
    const balanceBeforeWei = await this.readLedgerAvailableBalanceWei();
    if (balanceBeforeWei >= minWei) {
      return { deposited: false, balanceBeforeWei, balanceAfterWei: balanceBeforeWei };
    }
    try {
      await this.broker.ledger.depositFund(args.depositOG);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!/ledgerNotExists|LedgerNotExists/i.test(msg)) throw err;
      await this.broker.ledger.addLedger(args.depositOG);
    }
    const balanceAfterWei = await this.readLedgerAvailableBalanceWei();
    return { deposited: true, balanceBeforeWei, balanceAfterWei };
  }

  /**
   * Idempotent setup for a provider:
   *   1. Read current sub-account balance.
   *   2. If balance < `topUpThresholdOG` → top up the sub-account by
   *      `transferOG` (depositing into the main ledger first if needed).
   *   3. Acknowledge the provider signer (idempotent — secondary calls swallowed).
   *   4. Fetch service metadata.
   *
   * Returns the service URL + model + the action taken so the CLI can report
   * exactly what happened.
   *
   * `ledgerInitialOG` is the deposit size used when the main ledger needs to
   * be created or topped up to cover a transfer (3 OG minimum per 0G rules).
   * `transferOG` is the per-provider top-up amount (1 OG minimum).
   */
  async fundAndAcknowledge(args: {
    providerAddress: `0x${string}`;
    ledgerInitialOG: number;    // 3 OG minimum
    transferOG: number;         // 1 OG minimum
    topUpThresholdOG: number;   // skip top-up when sub-account >= this
  }): Promise<{
    serviceUrl: string;
    model: string;
    balanceBeforeWei: bigint;
    balanceAfterWei: bigint;
    toppedUp: boolean;
  }> {
    if (args.ledgerInitialOG < 3) {
      throw new Error('ledgerInitialOG must be >= 3 (0G ledger minimum)');
    }
    if (args.transferOG < 1) {
      throw new Error('transferOG must be >= 1 (per-provider minimum)');
    }

    const balanceBeforeWei = await this.readSubAccountBalanceWei(args.providerAddress);
    const thresholdWei = ethers.parseEther(String(args.topUpThresholdOG));
    const transferWei = ethers.parseEther(String(args.transferOG));

    let toppedUp = false;
    if (balanceBeforeWei < thresholdWei) {
      await this.ensureMainLedgerAndTransfer(args.providerAddress, args.ledgerInitialOG, transferWei);
      toppedUp = true;
    }

    // acknowledgeProviderSigner is required once per provider; secondary calls
    // throw on the contract side. Swallow only "already" errors.
    try {
      await this.broker.inference.acknowledgeProviderSigner(args.providerAddress);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!/already|acknowledged|exist/i.test(msg)) throw err;
    }

    const metadata = await this.broker.inference.getServiceMetadata(args.providerAddress);
    const serviceUrl = (metadata as { endpoint?: string }).endpoint ?? '';
    const model = (metadata as { model?: string }).model ?? '';
    if (!serviceUrl || !model) {
      throw new Error(`getServiceMetadata returned unexpected shape: ${JSON.stringify(metadata)}`);
    }

    const balanceAfterWei = toppedUp
      ? await this.readSubAccountBalanceWei(args.providerAddress)
      : balanceBeforeWei;

    return { serviceUrl, model, balanceBeforeWei, balanceAfterWei, toppedUp };
  }

  /**
   * Move `transferWei` from the main ledger to the provider sub-account.
   * If the main ledger doesn't exist yet, create it with `ledgerInitialOG`.
   * If it exists but has insufficient balance, deposit `ledgerInitialOG` more.
   */
  private async ensureMainLedgerAndTransfer(
    providerAddress: `0x${string}`,
    ledgerInitialOG: number,
    transferWei: bigint,
  ): Promise<void> {
    const tryTransfer = (): Promise<void> =>
      this.broker.ledger.transferFund(providerAddress, 'inference', transferWei);

    try {
      await tryTransfer();
      return;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isNoLedger = /ledgerNotExists|LedgerNotExists/i.test(msg);
      const isInsufficient = /InsufficientAvailableBalance|insufficient/i.test(msg);
      if (!isNoLedger && !isInsufficient) throw err;

      if (isNoLedger) {
        // No ledger yet — addLedger creates one with the given OG amount.
        await this.broker.ledger.addLedger(ledgerInitialOG);
      } else {
        // Ledger exists but main balance too low — deposit more.
        await this.broker.ledger.depositFund(ledgerInitialOG);
      }
      await tryTransfer();
    }
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

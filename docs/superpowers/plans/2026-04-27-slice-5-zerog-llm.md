# Slice 5 — AI integration (0G)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `StubLLMClient` with a real `ZeroGLLMClient` that runs every agent prompt through a 0G compute provider via `broker.inference.getRequestHeaders` + the `openai` package. Provide a one-time CLI (`npm run zerog-bootstrap`) that funds a provider sub-account and persists the runtime config to `./db/zerog-bootstrap.json`.

**Architecture:** `ai/zerog-broker/` owns the SDK glue: factory that builds a `ZGComputeNetworkBroker` from env, service that lists providers / funds + acknowledges them / caches metadata, and a JSON store for the bootstrap state. `ai/chat-model/` owns `ZeroGLLMClient` which holds a broker + provider config and translates our `LLMClient` interface to OpenAI-compatible HTTP calls (per-call settlement headers, retry once on transient failure, optional response validation). At `npm start`, bootstrap loads the JSON file and constructs the real LLM; falls back to `StubLLMClient` if missing.

**Tech Stack:** `@0glabs/0g-serving-broker` (broker SDK), `openai` (OpenAI client used against the proxy URL), `ethers@^6` (the broker SDK requires an ethers `Wallet`, distinct from slice 3's viem stack), our existing `LLMClient` interface from slice 4.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md) — section "AI Integration (0G)". The 0G chain RPC URLs and chainIds are already in `constants/zerog-networks.ts`.

**Test rule (slice 5):**
- `ZeroGBootstrapStore` gets a `*.live.test.ts` (real fs round-trip in tmpdir) — no 0G needed
- `ZeroGLLMClient` gets a `*.live.test.ts` that **skips when `db/zerog-bootstrap.json` is missing**, otherwise sends a trivial prompt against the real configured provider — covers the connect-and-respond path without costing fresh fees beyond what the stored ledger already has
- `ZeroGBrokerService` is exercised manually via the CLI (Task 6 has a smoke step). NO default-tier test — funding burns real OG.
- The CLI itself is not unit-tested; it's a thin driver. Smoke covers it.

---

## File Structure

```
src/ai/
  zerog-broker/
    types.ts                                # ZeroGBootstrapState, ProviderListing
    zerog-bootstrap-store.ts                # JSON read/write at db/zerog-bootstrap.json
    zerog-bootstrap-store.live.test.ts      # 4 round-trip tests (real fs)
    zerog-broker-factory.ts                 # buildBroker(env): ethers Wallet + broker
    zerog-broker-service.ts                 # listProviders, fundAndAcknowledge, getServiceMetadata
    bootstrap-cli.ts                        # interactive CLI; entry for `npm run zerog-bootstrap`
  chat-model/
    zerog-llm-client.ts                     # implements LLMClient using broker + openai
    zerog-llm-client.live.test.ts           # trivial prompt; skips if bootstrap.json absent
src/agent-runner/
  llm-client.ts                             # MODIFY — add optional tokenCount to LLMResponse
src/agent-runner/
  agent-runner.ts                           # MODIFY — pass tokenCount through to llmResponse log
src/index.ts                                # MODIFY — load bootstrap, log mismatch warning, pick LLM
package.json                                # MODIFY — deps + zerog-bootstrap script
```

---

## Task 1: Install runtime deps

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (regenerated)

- [ ] **Step 1: Install deps**

```bash
npm install @0glabs/0g-serving-broker openai ethers@^6
```

Expected resolved entries in `package.json` `dependencies`:

```json
{
  "@0glabs/0g-serving-broker": "^<latest 0.x>",
  "ethers": "^6",
  "openai": "^4"
}
```

Exact versions are whatever npm resolves at install time; the major-line constraints `^6` (ethers) and `^4` (openai) are what matter.

- [ ] **Step 2: Add the bootstrap CLI script**

Edit `/Users/pio/projects/open-agents-proj/open-agents-agent-loop/package.json` `scripts` block. Current block:

```json
{
  "build": "tsc -p tsconfig.json",
  "start": "tsx src/index.ts",
  "dev": "tsx watch src/index.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:interactive": "INTERACTIVE_TESTS=1 vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

Insert a `zerog-bootstrap` line:

```json
{
  "build": "tsc -p tsconfig.json",
  "start": "tsx src/index.ts",
  "dev": "tsx watch src/index.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:interactive": "INTERACTIVE_TESTS=1 vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "zerog-bootstrap": "tsx src/ai/zerog-broker/bootstrap-cli.ts"
}
```

- [ ] **Step 3: Verify project still typechecks**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Probe that the new deps import cleanly**

```bash
echo "import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'; import { Wallet } from 'ethers'; import OpenAI from 'openai'; void createZGComputeNetworkBroker; void Wallet; void OpenAI; console.log('imports ok');" > /tmp/zerog-probe.ts
npx tsx /tmp/zerog-probe.ts
rm /tmp/zerog-probe.ts
```

Expected output: `imports ok`. If `createZGComputeNetworkBroker` is not the exported symbol, that's a real blocker — report BLOCKED with the actual exports list.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install @0glabs/0g-serving-broker, openai, ethers for slice 5"
```

---

## Task 2: ZeroGBootstrapState type + ProviderListing

**Files:**
- Create: `src/ai/zerog-broker/types.ts`

No test (pure types).

- [ ] **Step 1: Create the types file**

```ts
import type { ZeroGNetworkName } from '../../constants';

// Persisted runtime state — written by the bootstrap CLI, read by `npm start`.
// Contains no secrets (0G auth is per-call via broker.inference.getRequestHeaders).
export interface ZeroGBootstrapState {
  network: ZeroGNetworkName;
  providerAddress: `0x${string}`;
  serviceUrl: string;        // OpenAI-compatible base URL for the chat completions endpoint
  model: string;             // e.g. "llama-3.3-70b-instruct"
  acknowledgedAt: number;    // epoch ms — when broker.inference.acknowledgeProviderSigner ran
  fundedAt: number;          // epoch ms — when transferFund last completed
  fundAmountOG: number;      // OG value transferred to provider sub-account on the most recent fund
}

// Returned by ZeroGBrokerService.listProviders for CLI display.
export interface ProviderListing {
  providerAddress: `0x${string}`;
  serviceUrl: string;
  model: string;
  inputPricePerToken?: bigint;  // wei per token
  outputPricePerToken?: bigint; // wei per token
  subAccountBalanceWei?: bigint; // best-effort; undefined if the SDK does not expose it
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/ai/zerog-broker/types.ts
git commit -m "feat(ai/zerog-broker): add ZeroGBootstrapState and ProviderListing types"
```

---

## Task 3: ZeroGBootstrapStore + live test

**Files:**
- Create: `src/ai/zerog-broker/zerog-bootstrap-store.ts`
- Create: `src/ai/zerog-broker/zerog-bootstrap-store.live.test.ts`

- [ ] **Step 1: Write the live test**

`src/ai/zerog-broker/zerog-bootstrap-store.live.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZeroGBootstrapStore } from './zerog-bootstrap-store';
import type { ZeroGBootstrapState } from './types';

const sample: ZeroGBootstrapState = {
  network: 'testnet',
  providerAddress: '0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08',
  serviceUrl: 'https://provider.example.0g.ai/v1',
  model: 'llama-3.3-70b-instruct',
  acknowledgedAt: 1_700_000_000_000,
  fundedAt: 1_700_000_500_000,
  fundAmountOG: 1,
};

describe('ZeroGBootstrapStore (live, real filesystem)', () => {
  let dbDir: string;
  let store: ZeroGBootstrapStore;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-zerog-'));
    store = new ZeroGBootstrapStore(dbDir);
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns null when no bootstrap file exists', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips a full bootstrap state', async () => {
    await store.save(sample);
    const loaded = await store.load();
    console.log('[zerog-store] loaded:', loaded);
    expect(loaded).toEqual(sample);
  });

  it('overwrites a previous state on repeated save', async () => {
    await store.save(sample);
    const updated = { ...sample, fundAmountOG: 2, fundedAt: sample.fundedAt + 1 };
    await store.save(updated);
    expect(await store.load()).toEqual(updated);
  });

  it('writes JSON at db/zerog-bootstrap.json with 2-space indent', async () => {
    await store.save(sample);
    const raw = await readFile(join(dbDir, 'zerog-bootstrap.json'), 'utf8');
    expect(raw).toContain('  "network": "testnet"');  // indented two spaces
    expect(JSON.parse(raw)).toEqual(sample);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ai/zerog-broker/`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `zerog-bootstrap-store.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZeroGBootstrapState } from './types';

export class ZeroGBootstrapStore {
  constructor(private readonly dbDir: string) {}

  async load(): Promise<ZeroGBootstrapState | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as ZeroGBootstrapState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(state: ZeroGBootstrapState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(state, null, 2), 'utf8');
  }

  private get path(): string {
    return join(this.dbDir, 'zerog-bootstrap.json');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ai/zerog-broker/`
Expected: PASS — 4 tests pass; loaded sample logged.

- [ ] **Step 5: Commit**

```bash
git add src/ai/zerog-broker/zerog-bootstrap-store.ts src/ai/zerog-broker/zerog-bootstrap-store.live.test.ts
git commit -m "feat(ai/zerog-broker): add ZeroGBootstrapStore with round-trip live test"
```

---

## Task 4: Add tokenCount to LLMResponse + thread through AgentRunner

**Files:**
- Modify: `src/agent-runner/llm-client.ts`
- Modify: `src/agent-runner/agent-runner.ts`

The `AgentActivityLog.llmResponse` payload type already accepts an optional `tokenCount` (slice 2). We make `LLMResponse` carry it through.

- [ ] **Step 1: Update `src/agent-runner/llm-client.ts`**

Replace the file with:

```ts
export interface LLMResponse {
  content: string;
  tokenCount?: number;
}

export interface LLMClient {
  modelName(): string;
  invoke(prompt: string): Promise<LLMResponse>;
}
```

- [ ] **Step 2: Update `src/agent-runner/agent-runner.ts` to pass `tokenCount` to `llmResponse`**

Find this block in `run()`:

```ts
      const response = await this.llm.invoke(prompt);
      await this.activityLog.llmResponse(agent.id, tickId, {
        model: this.llm.modelName(),
        responseChars: response.content.length,
      });
```

Replace with:

```ts
      const response = await this.llm.invoke(prompt);
      await this.activityLog.llmResponse(agent.id, tickId, {
        model: this.llm.modelName(),
        responseChars: response.content.length,
        ...(response.tokenCount !== undefined ? { tokenCount: response.tokenCount } : {}),
      });
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Verify slice 4 tests still pass**

Run: `npx vitest run src/agent-runner/ src/agent-looper/`
Expected: 13 tests pass (unchanged from slice 4 — `tokenCount` is optional and `StubLLMClient` doesn't set it).

- [ ] **Step 5: Commit**

```bash
git add src/agent-runner/llm-client.ts src/agent-runner/agent-runner.ts
git commit -m "feat(agent-runner): thread optional tokenCount from LLMResponse to activity log"
```

---

## Task 5: ZeroGBrokerFactory

**Files:**
- Create: `src/ai/zerog-broker/zerog-broker-factory.ts`

Builds an ethers `JsonRpcProvider` + `Wallet` against the configured 0G network and constructs the broker. No test — exercised by Task 6 and Task 8 against the real chain.

- [ ] **Step 1: Implement `zerog-broker-factory.ts`**

```ts
import { JsonRpcProvider, Wallet } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import { ZEROG_NETWORKS, type ZeroGNetworkName } from '../../constants';

export interface BrokerEnv {
  WALLET_PRIVATE_KEY: string;
  ZEROG_NETWORK: ZeroGNetworkName;
}

// Resolves to the SDK's broker type. We intentionally `Awaited<ReturnType<...>>`
// rather than importing a named class — the SDK's exported types have churned
// across versions; this stays robust.
export type ZeroGBroker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export async function buildZeroGBroker(env: BrokerEnv): Promise<{
  broker: ZeroGBroker;
  walletAddress: `0x${string}`;
}> {
  const network = ZEROG_NETWORKS[env.ZEROG_NETWORK];
  const provider = new JsonRpcProvider(network.rpcUrl);
  const wallet = new Wallet(env.WALLET_PRIVATE_KEY, provider);
  const broker = await createZGComputeNetworkBroker(wallet);
  return { broker, walletAddress: wallet.address as `0x${string}` };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/ai/zerog-broker/zerog-broker-factory.ts
git commit -m "feat(ai/zerog-broker): add buildZeroGBroker (ethers wallet + 0G chain RPC)"
```

---

## Task 6: ZeroGBrokerService — list, fund, acknowledge

**Files:**
- Create: `src/ai/zerog-broker/zerog-broker-service.ts`

This is the highest-uncertainty file in the slice. The SDK's exact method names + return shapes are not fully documented — the implementer should verify against `node_modules/@0glabs/0g-serving-broker/dist/index.d.ts` before writing code. The spec below describes the contract; the SDK call sites adapt to whatever the installed version exposes.

**Known SDK surface (from 0G docs + starter kit):**
- `broker.inference.listService()` → array of services. Field names confirmed at runtime; some installations expose `provider`/`url`/`model`/`inputPrice`/`outputPrice`, but treat the shape as opaque and adapt.
- `broker.ledger.addLedger(ogAmount: number)` → creates the ledger; throws if it already exists.
- `broker.ledger.transferFund(provider: string, serviceType: 'inference', amount: bigint)` → transfers OG from ledger to provider sub-account.
- `broker.inference.acknowledgeProviderSigner(provider: string)` → one-time TEE attestation acknowledgement.
- `broker.inference.getServiceMetadata(provider: string)` → `{ endpoint, model }`.

If `broker.ledger.getLedger()` exists in the installed version, use it to detect already-funded ledgers; otherwise, catch the `addLedger` error and continue.

- [ ] **Step 1: Implement `zerog-broker-service.ts`**

```ts
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
    const services = (await this.broker.inference.listService()) as Array<Record<string, unknown>>;
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
```

**Note on sub-account balance:** the public SDK README does not document a stable per-provider balance method. A future task can extend `listProviders` to populate `subAccountBalanceWei` once the API is verified — for now operators read it via `0g-compute-cli get-account` and the CLI listing prints "balance unknown".

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/ai/zerog-broker/zerog-broker-service.ts
git commit -m "feat(ai/zerog-broker): add ZeroGBrokerService.listProviders and fundAndAcknowledge"
```

---

## Task 7: Bootstrap CLI

**Files:**
- Create: `src/ai/zerog-broker/bootstrap-cli.ts`

Two modes driven by `process.env.ZEROG_PROVIDER_ADDRESS`:
- **List mode** (env var unset): prints all providers with model/url/price; exits with hint to set the env var.
- **Fund mode** (env var set to a `0x...` address): prompts y/n showing total OG cost, then funds + acknowledges + persists.

- [ ] **Step 1: Implement `bootstrap-cli.ts`**

```ts
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadEnv } from '../../config/env';
import { buildZeroGBroker } from './zerog-broker-factory';
import { ZeroGBrokerService } from './zerog-broker-service';
import { ZeroGBootstrapStore } from './zerog-bootstrap-store';
import type { ZeroGBootstrapState } from './types';

const DEFAULT_LEDGER_OG = 3;       // 0G ledger minimum
const DEFAULT_TRANSFER_OG = 1;     // 0G per-provider minimum

async function confirm(q: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { broker, walletAddress } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: env.ZEROG_NETWORK,
  });
  const service = new ZeroGBrokerService(broker);
  const store = new ZeroGBootstrapStore(env.DB_DIR);

  console.log(`[zerog-bootstrap] network=${env.ZEROG_NETWORK} wallet=${walletAddress}`);
  console.log(`[zerog-bootstrap] listing providers...`);

  const providers = await service.listProviders();
  if (providers.length === 0) {
    console.error('[zerog-bootstrap] no providers returned by listService()');
    process.exit(1);
  }

  console.log('');
  console.log('Available providers (sub-account balance: see `0g-compute-cli get-account`):');
  console.log('');
  for (const p of providers) {
    const inPrice = p.inputPricePerToken !== undefined ? `${p.inputPricePerToken} wei/in` : 'in: ?';
    const outPrice = p.outputPricePerToken !== undefined ? `${p.outputPricePerToken} wei/out` : 'out: ?';
    console.log(`  ${p.providerAddress}  model=${p.model}  ${inPrice}  ${outPrice}`);
    console.log(`    url=${p.serviceUrl}`);
  }
  console.log('');

  const target = process.env.ZEROG_PROVIDER_ADDRESS;
  if (!target) {
    console.log('[zerog-bootstrap] set ZEROG_PROVIDER_ADDRESS=<address> in .env, then re-run `npm run zerog-bootstrap` to fund + persist.');
    return;
  }

  const chosen = providers.find((p) => p.providerAddress.toLowerCase() === target.toLowerCase());
  if (!chosen) {
    console.error(`[zerog-bootstrap] ZEROG_PROVIDER_ADDRESS=${target} not present in listService output.`);
    process.exit(1);
  }

  const ledgerOG = Number(process.env.ZEROG_LEDGER_OG ?? DEFAULT_LEDGER_OG);
  const transferOG = Number(process.env.ZEROG_TRANSFER_OG ?? DEFAULT_TRANSFER_OG);

  console.log(`[zerog-bootstrap] selected ${chosen.providerAddress} (${chosen.model})`);
  console.log(`[zerog-bootstrap] plan: addLedger(${ledgerOG} OG) (skipped if exists), then transferFund(${transferOG} OG) to provider sub-account, then acknowledge.`);

  const ok = await confirm(`Proceed? Total potential cost: ${ledgerOG} OG (only on first run; ${transferOG} OG on subsequent top-ups).`);
  if (!ok) {
    console.log('[zerog-bootstrap] cancelled.');
    return;
  }

  console.log('[zerog-bootstrap] funding + acknowledging...');
  const { serviceUrl, model } = await service.fundAndAcknowledge({
    providerAddress: chosen.providerAddress,
    ledgerInitialOG: ledgerOG,
    transferOG,
  });

  const now = Date.now();
  const state: ZeroGBootstrapState = {
    network: env.ZEROG_NETWORK,
    providerAddress: chosen.providerAddress,
    serviceUrl,
    model,
    acknowledgedAt: now,
    fundedAt: now,
    fundAmountOG: transferOG,
  };
  await store.save(state);

  console.log(`[zerog-bootstrap] persisted ${env.DB_DIR}/zerog-bootstrap.json`);
  console.log(`[zerog-bootstrap] next: run \`npm test\` to exercise the live LLM, or \`npm start\` to use it for agent ticks.`);
}

main().catch((err) => {
  console.error('[zerog-bootstrap] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Smoke the list path (does not spend OG)**

Requires a valid `WALLET_PRIVATE_KEY` (0x + 64 hex) in `.env` with at least a tiny amount of native OG for RPC reads. With `ZEROG_PROVIDER_ADDRESS` UNSET:

```bash
unset ZEROG_PROVIDER_ADDRESS
npm run zerog-bootstrap
```

Expected: prints the provider list and the hint message; exits 0 without funding. If `WALLET_PRIVATE_KEY` is invalid the env loader fails first — fix that and re-run.

If the SDK throws (network down, provider list empty, signature mismatch with installed SDK), report exact error verbatim. The implementer may need to adapt `pickAddress` / `pickString` keys to whatever the installed SDK actually returns.

- [ ] **Step 4: Commit**

```bash
git add src/ai/zerog-broker/bootstrap-cli.ts
git commit -m "feat(ai/zerog-broker): add bootstrap CLI (list + fund + persist)"
```

---

## Task 8: ZeroGLLMClient + live test

**Files:**
- Create: `src/ai/chat-model/zerog-llm-client.ts`
- Create: `src/ai/chat-model/zerog-llm-client.live.test.ts`

The client wraps the broker + an `OpenAI` instance. Per call: get headers, call chat completions with those headers, extract content + token usage, optionally validate with `processResponse` (best-effort — log if validation fails but return the content). One retry on any failure with a 1 s delay.

- [ ] **Step 1: Implement `zerog-llm-client.ts`**

```ts
import OpenAI from 'openai';
import type { LLMClient, LLMResponse } from '../../agent-runner/llm-client';
import type { ZeroGBroker } from '../zerog-broker/zerog-broker-factory';

const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 1_000;

export interface ZeroGLLMClientOptions {
  broker: ZeroGBroker;
  providerAddress: `0x${string}`;
  serviceUrl: string;
  model: string;
  retries?: number;
}

export class ZeroGLLMClient implements LLMClient {
  private readonly broker: ZeroGBroker;
  private readonly providerAddress: `0x${string}`;
  private readonly model: string;
  private readonly retries: number;
  private readonly openai: OpenAI;

  constructor(opts: ZeroGLLMClientOptions) {
    this.broker = opts.broker;
    this.providerAddress = opts.providerAddress;
    this.model = opts.model;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.openai = new OpenAI({ baseURL: opts.serviceUrl, apiKey: 'unused-by-0g-proxy' });
  }

  modelName(): string {
    return this.model;
  }

  async invoke(prompt: string): Promise<LLMResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.invokeOnce(prompt);
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    throw lastErr;
  }

  private async invokeOnce(prompt: string): Promise<LLMResponse> {
    const headers = (await this.broker.inference.getRequestHeaders(this.providerAddress, prompt)) as Record<string, string>;
    const completion = await this.openai.chat.completions.create(
      { messages: [{ role: 'user', content: prompt }], model: this.model },
      { headers },
    );

    const content = completion.choices[0]?.message?.content ?? '';
    const tokenCount = completion.usage?.total_tokens;

    // Best-effort settlement validation. Failure here doesn't change the
    // returned content — the call already happened — but we log it so a
    // human can investigate provider-side mismatches.
    try {
      const isValid = await this.broker.inference.processResponse(
        this.providerAddress,
        completion.id,
        content,
      );
      if (isValid === false) {
        console.warn('[zerog-llm] processResponse returned false; provider settlement may have rejected this call');
      }
    } catch (err) {
      console.warn('[zerog-llm] processResponse threw:', (err as Error).message);
    }

    return {
      content,
      ...(tokenCount !== undefined ? { tokenCount } : {}),
    };
  }
}
```

- [ ] **Step 2: Write the live test**

`src/ai/chat-model/zerog-llm-client.live.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZeroGLLMClient } from './zerog-llm-client';
import { buildZeroGBroker } from '../zerog-broker/zerog-broker-factory';
import { ZeroGBootstrapStore } from '../zerog-broker/zerog-bootstrap-store';

const KEY = process.env.WALLET_PRIVATE_KEY;
const KEY_VALID = typeof KEY === 'string' && /^0x[0-9a-fA-F]{64}$/.test(KEY);
const dbDir = process.env.DB_DIR ?? './db';
const bootstrapExists = existsSync(join(dbDir, 'zerog-bootstrap.json'));

describe.skipIf(!KEY_VALID || !bootstrapExists)('ZeroGLLMClient (live, real 0G provider)', () => {
  let client: ZeroGLLMClient;

  beforeAll(async () => {
    const store = new ZeroGBootstrapStore(dbDir);
    const state = await store.load();
    if (!state) throw new Error('bootstrap state expected (skip-guard above should have skipped)');

    const { broker } = await buildZeroGBroker({
      WALLET_PRIVATE_KEY: KEY!,
      ZEROG_NETWORK: state.network,
    });
    client = new ZeroGLLMClient({
      broker,
      providerAddress: state.providerAddress,
      serviceUrl: state.serviceUrl,
      model: state.model,
    });
  });

  it('reports the configured model name', () => {
    expect(client.modelName()).toMatch(/.+/);
    console.log('[zerog-llm] model:', client.modelName());
  });

  it('responds to a trivial prompt with a non-empty string', async () => {
    const res = await client.invoke('Reply with the single word OK and nothing else.');
    console.log('[zerog-llm] response:', res.content);
    console.log('[zerog-llm] tokens:', res.tokenCount);
    expect(typeof res.content).toBe('string');
    expect(res.content.length).toBeGreaterThan(0);
  }, 30_000);
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/ai/chat-model/`
Expected:
- If `db/zerog-bootstrap.json` is present and `WALLET_PRIVATE_KEY` is valid: 2 tests pass; the response and token count are logged.
- Otherwise: SKIPPED (the test guard catches both conditions).

- [ ] **Step 4: Commit**

```bash
git add src/ai/chat-model/zerog-llm-client.ts src/ai/chat-model/zerog-llm-client.live.test.ts
git commit -m "feat(ai/chat-model): add ZeroGLLMClient with retry, processResponse validation, tokenCount"
```

---

## Task 9: Wire bootstrap loader into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

On startup: try to load `db/zerog-bootstrap.json`. If it exists, build a `ZeroGLLMClient`. If not, fall back to `StubLLMClient` and log a hint. If `state.network !== env.ZEROG_NETWORK`, log a warning and use the file (per spec).

- [ ] **Step 1: Replace `src/index.ts` with the bootstrap-aware version**

```ts
import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { AgentOrchestrator } from './agent-looper/agent-orchestrator';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';
import type { LLMClient } from './agent-runner/llm-client';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker } from './ai/zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from './ai/chat-model/zerog-llm-client';

async function buildLLM(env: Env): Promise<LLMClient> {
  const store = new ZeroGBootstrapStore(env.DB_DIR);
  const state = await store.load();
  if (!state) {
    console.log('[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.');
    return new StubLLMClient();
  }

  if (state.network !== env.ZEROG_NETWORK) {
    console.warn(
      `[bootstrap] WARNING: zerog-bootstrap.json was funded on '${state.network}' but env says '${env.ZEROG_NETWORK}'; using the file's network. Delete db/zerog-bootstrap.json and re-run \`npm run zerog-bootstrap\` to switch.`,
    );
  }

  const { broker } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: state.network,
  });
  console.log(`[bootstrap] 0G LLM ready — network=${state.network} provider=${state.providerAddress} model=${state.model}`);
  return new ZeroGLLMClient({
    broker,
    providerAddress: state.providerAddress,
    serviceUrl: state.serviceUrl,
    model: state.model,
  });
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  const db = new FileDatabase(env.DB_DIR);
  const activityLog = new AgentActivityLog(new FileActivityLogStore(env.DB_DIR));
  const walletFactory = new WalletFactory(env, db.transactions);
  const llm = await buildLLM(env);
  const runner = new AgentRunner(db, activityLog, walletFactory, llm);
  const orchestrator = new AgentOrchestrator(db, runner);

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);
  console.log(`[bootstrap] wallet factory initialized`);
  console.log(`[bootstrap] agent runner initialized (LLM: ${llm.modelName()})`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(
        `[looper] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
      );
      await orchestrator.tick();
    },
  });

  looper.start();
  console.log(`[bootstrap] looper started, ticking every ${LOOPER.tickIntervalMs}ms`);

  const shutdown = (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping looper`);
    looper.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
```

(The `main` function became `async` because LLM construction is async. Other behavior unchanged from slice 4.)

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Smoke without bootstrap.json (StubLLMClient path)**

Make sure `db/zerog-bootstrap.json` does not exist:

```bash
rm -f ./db/zerog-bootstrap.json
WALLET_PRIVATE_KEY=0x$(printf '11%.0s' {1..32}) npm start &
PID=$!
sleep 12
kill $PID 2>/dev/null
wait $PID 2>/dev/null
```

Expected output (timestamps differ; key lines):

```
[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.
[bootstrap] env loaded — ZEROG_NETWORK=mainnet, DB_DIR=./db
[bootstrap] database + activity log initialized at ./db
[bootstrap] wallet factory initialized
[bootstrap] agent runner initialized (LLM: stub)
[bootstrap] looper started, ticking every 10000ms
[looper] tick @ 2026-04-27T...Z — 0 agent(s) loaded
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: load zerog-bootstrap.json on startup; pick ZeroGLLMClient or StubLLMClient"
```

---

## Task 10: Full sweep + tag

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected:
- `zerog-bootstrap-store.live.test.ts` — 4 pass
- `zerog-llm-client.live.test.ts` — 2 pass (if `db/zerog-bootstrap.json` present and key valid) or SKIPPED
- All slice 1–4 suites pass / skip as before
- Only known failure: pre-existing Firecrawl 402

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: exit code 0; `dist/` populated with `ai/` subtree.

- [ ] **Step 3: Verify directory structure**

Run: `find src/ai -type f | sort`

Expected:
```
src/ai/chat-model/zerog-llm-client.live.test.ts
src/ai/chat-model/zerog-llm-client.ts
src/ai/zerog-broker/bootstrap-cli.ts
src/ai/zerog-broker/types.ts
src/ai/zerog-broker/zerog-bootstrap-store.live.test.ts
src/ai/zerog-broker/zerog-bootstrap-store.ts
src/ai/zerog-broker/zerog-broker-factory.ts
src/ai/zerog-broker/zerog-broker-service.ts
```

- [ ] **Step 4: Tag the slice**

```bash
git tag slice-5-zerog-llm
```

- [ ] **Step 5: Final log inspection**

Run: `git log --oneline slice-4-runner-orchestrator..HEAD`
Expected: 10 commits (Tasks 1–9 plus the docs/plan commit that precedes Task 1).

---

## Out of Scope for Slice 5

Deferred to later slices:
- LLM tool calls (Coingecko, wallet balance, Uniswap quote/swap) — Slice 6
- LLM-driven memory writes — Slice 6
- Uniswap module + swap execution — Slice 7
- Seed agent end-to-end — Slice 8
- Per-provider sub-account balance display in the CLI — punted to a later improvement (the SDK API needs verification; for now operators use `0g-compute-cli get-account`)
- Streaming responses — never (single-shot prompt/response is enough for v1)
- Multi-provider failover — never for v1
- Langchain integration — Slice 6 evaluates whether to use Langchain for the tool framework or build a minimal alternative on top of `LLMClient`

---

## Self-Review

**Spec coverage check:**
- ✅ "AI Integration (0G)" — Constants vs db split honored: chain RPC URLs in `constants/zerog-networks.ts` (slice 1), per-bootstrap runtime state at `db/zerog-bootstrap.json` (Task 3) — Tasks 2, 3
- ✅ Bootstrap flow: connect via `ZEROG_NETWORK` + `WALLET_PRIVATE_KEY`; auto-pick rejected in favor of explicit `ZEROG_PROVIDER_ADDRESS` (per locked decision) — Task 7
- ✅ Persisted state survives restart; re-bootstrap requires deleting the file — Tasks 3, 9
- ✅ `ZeroGLLMClient` integrates with our `LLMClient` interface from slice 4 — Task 8
- ✅ Activity log captures `tokenCount` when the LLM provides it — Task 4 (type) + Task 8 (population)
- ✅ Network mismatch warning, bootstrap.json wins — Task 9 (per locked decision #3)
- ✅ Single retry on transient LLM failures — Task 8 (per locked decision #4)
- ✅ Funding minimums enforced: ledger ≥ 3 OG, transfer ≥ 1 OG — Task 6

**Placeholder scan:** No TBDs, no "implement later", no "handle edge cases" without code. The "research SDK first" note in Task 6 is accompanied by exact contract code; the implementer adapts only the field-picking helpers to whatever the installed SDK exposes.

**Type consistency:**
- `ZeroGBootstrapState` defined once in Task 2; consumed in Tasks 3, 7, 8, 9 — fields stable across all sites
- `ProviderListing` defined Task 2; produced by `ZeroGBrokerService.listProviders` (Task 6); consumed by `bootstrap-cli.ts` (Task 7)
- `ZeroGBroker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>` defined Task 5; reused in Tasks 6, 8, 9 — single source of truth even if SDK class names change
- `LLMResponse` extended in Task 4; consumed in Task 8 (`ZeroGLLMClient.invoke`) and the existing `AgentRunner` log call site
- `ZeroGNetworkName` from slice 1 used in Tasks 2, 5
- `loadEnv` / `Env` from slice 1 used in Tasks 7, 9

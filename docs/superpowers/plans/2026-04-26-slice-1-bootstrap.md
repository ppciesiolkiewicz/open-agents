# Slice 1 — Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project skeleton (package.json, TS, vitest, .gitignore), the `config/` env loader, the `constants/` module, all four data providers (Coingecko, CoinMarketCap, Serper, Firecrawl) each with a **live** smoke test using the UNI/USDC pair on Unichain, and an empty `agent-looper/` that ticks on the cadence from `constants/` but loads no agents. End state: `npm test` runs the live provider tests and `npm start` runs the empty loop.

**Architecture:** TypeScript (Node 20+), classes for all modules. Tests live only for **providers and integrations** as `*.live.test.ts` files — they hit the real API and `console.log` the response. Env loader, constants, and the looper get no tests in this slice (we exercise them via `npm start`). zod for env validation, native `fetch` for HTTP.

**Tech Stack:** Node 20+, TypeScript 5.x, vitest, zod, dotenv, tsx, native `fetch`.

**Spec reference:** [docs/superpowers/specs/2026-04-26-agent-loop-foundation-design.md](../specs/2026-04-26-agent-loop-foundation-design.md)

**Test rule (applies to every test in this plan):**
- Only providers/integrations get tests. File suffix: `*.live.test.ts`.
- No mocked HTTP. Hit the real API.
- Skip when the relevant API key is missing.
- Assert the call returned something sensible, then `console.log` the payload so a human can eyeball it.

---

## File Structure

```
open-agents-agent-loop/
  package.json
  tsconfig.json
  vitest.config.ts
  vitest.setup.ts
  .gitignore
  .env                                      # already exists, do not overwrite
  src/
    config/
      env.ts                                # zod-validated typed env (no test)
    constants/
      unichain.ts                           # (no test)
      zerog-networks.ts
      tokens.ts
      pools.ts
      looper.ts
      index.ts
    providers/
      coingecko/
        coingecko-service.ts
        coingecko-service.live.test.ts      # LIVE — fetches UNI + USDC price, logs them
      coinmarketcap/
        coinmarketcap-service.ts
        coinmarketcap-service.live.test.ts  # LIVE — fetches UNI + USDC info, logs them
      serper/
        serper-service.ts
        serper-service.live.test.ts         # LIVE — searches "UNI token", logs top 3
      firecrawl/
        firecrawl-service.ts
        firecrawl-service.live.test.ts      # LIVE — scrapes uniswap.org, logs preview
    agent-looper/
      looper.ts                             # (no test in this slice)
    index.ts                                # bootstrap → new Looper(...).start()
```

---

## Task 1: Project skeleton + git init

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder)

- [ ] **Step 1: Initialize git**

```bash
git init
git branch -m main
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
dist/
db/
.env
.env.*
!.env.example
*.swp
.DS_Store
coverage/
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "open-agents-agent-loop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:interactive": "INTERACTIVE_TESTS=1 vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "isolatedModules": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.live.test.ts"]
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
  },
});
```

(30s timeout because live HTTP calls. The include pattern accepts both `.test.ts` and `.live.test.ts` so future slices that add non-integration tests don't need a config change.)

- [ ] **Step 6: Create `vitest.setup.ts`**

```ts
import 'dotenv/config';
```

- [ ] **Step 7: Create `src/index.ts` placeholder**

```ts
export {};
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`
Expected: `node_modules/` and `package-lock.json` created.

- [ ] **Step 9: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 10: Commit**

```bash
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts vitest.setup.ts src/index.ts
git commit -m "chore: scaffold typescript project with vitest"
```

---

## Task 2: Env loader (`config/env.ts`)

**Files:**
- Create: `src/config/env.ts`

No test in this slice — it's exercised when `npm start` calls `loadEnv()` against the real `.env`.

- [ ] **Step 1: Implement `src/config/env.ts`**

```ts
import { z } from 'zod';

const envSchema = z.object({
  WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'WALLET_PRIVATE_KEY must be 0x-prefixed 32-byte hex'),

  ALCHEMY_API_KEY: z.string().min(1),
  UNICHAIN_RPC_URL: z.string().url().optional(),

  ZEROG_NETWORK: z.enum(['mainnet', 'testnet']),
  ZEROG_PROVIDER_ADDRESS: z.string().optional(),

  COINGECKO_API_KEY: z.string().min(1),
  COINMARKETCAP_API_KEY: z.string().min(1),
  SERPER_API_KEY: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),

  DB_DIR: z.string().default('./db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid env: ${issues}`);
  }
  return parsed.data;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/config/
git commit -m "feat(config): add zod-validated env loader"
```

---

## Task 3: Constants module

**Files:**
- Create: `src/constants/unichain.ts`
- Create: `src/constants/zerog-networks.ts`
- Create: `src/constants/tokens.ts`
- Create: `src/constants/pools.ts`
- Create: `src/constants/looper.ts`
- Create: `src/constants/index.ts`

No tests — values are constants, exercised by every consumer.

- [ ] **Step 1: Implement `src/constants/unichain.ts`**

```ts
export interface UnichainConfig {
  chainId: 130;
  nativeSymbol: 'ETH';
}

export const UNICHAIN: UnichainConfig = {
  chainId: 130,
  nativeSymbol: 'ETH',
};

export function resolveUnichainRpcUrl(env: {
  UNICHAIN_RPC_URL?: string;
  ALCHEMY_API_KEY: string;
}): string {
  return env.UNICHAIN_RPC_URL ?? `https://unichain-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
}
```

- [ ] **Step 2: Implement `src/constants/zerog-networks.ts`**

```ts
export interface ZeroGNetwork {
  chainId: number;
  rpcUrl: string;
}

export const ZEROG_NETWORKS = {
  mainnet: { chainId: 16661, rpcUrl: 'https://evmrpc.0g.ai' },
  testnet: { chainId: 16602, rpcUrl: 'https://evmrpc-testnet.0g.ai' },
} as const satisfies Record<'mainnet' | 'testnet', ZeroGNetwork>;

export type ZeroGNetworkName = keyof typeof ZEROG_NETWORKS;
```

- [ ] **Step 3: Implement `src/constants/tokens.ts`**

```ts
export interface TokenInfo {
  address: `0x${string}`;
  decimals: number;
  symbol: string;
}

export const TOKENS = {
  USDC: {
    address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    decimals: 6,
    symbol: 'USDC',
  },
  UNI: {
    address: '0x8f187aA05619a017077f5308904739877ce9eA21',
    decimals: 18,
    symbol: 'UNI',
  },
} as const satisfies Record<string, TokenInfo>;

export type TokenSymbol = keyof typeof TOKENS;
```

- [ ] **Step 4: Implement `src/constants/pools.ts`**

```ts
export const POOLS = {
  // Uniswap v4 PoolKeys filled in slice 7.
} as const;
```

- [ ] **Step 5: Implement `src/constants/looper.ts`**

```ts
export const LOOPER = {
  tickIntervalMs: 10_000,
} as const;
```

- [ ] **Step 6: Implement `src/constants/index.ts`**

```ts
export * from './unichain';
export * from './zerog-networks';
export * from './tokens';
export * from './pools';
export * from './looper';
```

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
git add src/constants/
git commit -m "feat(constants): add unichain, 0g networks, tokens, pools, looper"
```

---

## Task 4: Coingecko provider (live)

**Files:**
- Create: `src/providers/coingecko/coingecko-service.ts`
- Create: `src/providers/coingecko/coingecko-service.live.test.ts`

- [ ] **Step 1: Write the failing live test**

`src/providers/coingecko/coingecko-service.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CoingeckoService } from './coingecko-service';

const apiKey = process.env.COINGECKO_API_KEY;

describe.skipIf(!apiKey)('CoingeckoService (live, UNI/USDC)', () => {
  const svc = new CoingeckoService({ apiKey: apiKey! });

  it('fetches a UNI price', async () => {
    const price = await svc.fetchTokenPriceUSD('uniswap');
    console.log('[coingecko] UNI price USD =', price);
    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(0);
  });

  it('fetches a USDC price', async () => {
    const price = await svc.fetchTokenPriceUSD('usd-coin');
    console.log('[coingecko] USDC price USD =', price);
    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/coingecko/`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `coingecko-service.ts`**

```ts
export interface CoingeckoServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export class CoingeckoService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: CoingeckoServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.coingecko.com/api/v3';
  }

  async fetchTokenPriceUSD(coingeckoId: string): Promise<number> {
    const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(coingeckoId)}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { 'x-cg-demo-api-key': this.apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Coingecko request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const price = body[coingeckoId]?.usd;
    if (typeof price !== 'number') {
      throw new Error(`Coingecko response missing usd price for ${coingeckoId}`);
    }
    return price;
  }
}
```

- [ ] **Step 4: Run live test**

Run: `npx vitest run src/providers/coingecko/`
Expected: PASS (if `COINGECKO_API_KEY` set in `.env`); two prices logged. SKIPPED otherwise.

- [ ] **Step 5: Commit**

```bash
git add src/providers/coingecko/
git commit -m "feat(providers): add CoingeckoService with live UNI/USDC price test"
```

---

## Task 5: CoinMarketCap provider (live)

**Files:**
- Create: `src/providers/coinmarketcap/coinmarketcap-service.ts`
- Create: `src/providers/coinmarketcap/coinmarketcap-service.live.test.ts`

- [ ] **Step 1: Write the failing live test**

`src/providers/coinmarketcap/coinmarketcap-service.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CoinMarketCapService } from './coinmarketcap-service';

const apiKey = process.env.COINMARKETCAP_API_KEY;

describe.skipIf(!apiKey)('CoinMarketCapService (live, UNI/USDC)', () => {
  const svc = new CoinMarketCapService({ apiKey: apiKey! });

  it('fetches metadata for UNI', async () => {
    const info = await svc.fetchTokenInfoBySymbol('UNI');
    console.log('[cmc] UNI info:', { id: info.id, name: info.name, symbol: info.symbol, slug: info.slug });
    expect(info.symbol).toBe('UNI');
    expect(typeof info.name).toBe('string');
  });

  it('fetches metadata for USDC', async () => {
    const info = await svc.fetchTokenInfoBySymbol('USDC');
    console.log('[cmc] USDC info:', { id: info.id, name: info.name, symbol: info.symbol, slug: info.slug });
    expect(info.symbol).toBe('USDC');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/coinmarketcap/`
Expected: FAIL.

- [ ] **Step 3: Implement `coinmarketcap-service.ts`**

```ts
export interface CoinMarketCapServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface CmcTokenInfo {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  category?: string;
  description?: string;
}

export class CoinMarketCapService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: CoinMarketCapServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://pro-api.coinmarketcap.com';
  }

  async fetchTokenInfoBySymbol(symbol: string): Promise<CmcTokenInfo> {
    const url = `${this.baseUrl}/v2/cryptocurrency/info?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': this.apiKey,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`CoinMarketCap request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { data?: Record<string, CmcTokenInfo[]> };
    const entry = body.data?.[symbol]?.[0];
    if (!entry) {
      throw new Error(`CoinMarketCap response missing entry for ${symbol}`);
    }
    return entry;
  }
}
```

- [ ] **Step 4: Run live test**

Run: `npx vitest run src/providers/coinmarketcap/`
Expected: PASS; UNI + USDC info logged. SKIPPED if key missing.

- [ ] **Step 5: Commit**

```bash
git add src/providers/coinmarketcap/
git commit -m "feat(providers): add CoinMarketCapService with live UNI/USDC info test"
```

---

## Task 6: Serper provider (live)

**Files:**
- Create: `src/providers/serper/serper-service.ts`
- Create: `src/providers/serper/serper-service.live.test.ts`

- [ ] **Step 1: Write the failing live test**

`src/providers/serper/serper-service.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SerperService } from './serper-service';

const apiKey = process.env.SERPER_API_KEY;

describe.skipIf(!apiKey)('SerperService (live)', () => {
  const svc = new SerperService({ apiKey: apiKey! });

  it('searches for "UNI token Uniswap"', async () => {
    const results = await svc.searchWeb('UNI token Uniswap');
    console.log('[serper] top 3 results for "UNI token Uniswap":');
    for (const r of results.slice(0, 3)) {
      console.log('  -', r.title, '→', r.link);
    }
    expect(results.length).toBeGreaterThan(0);
  });

  it('searches for "USDC stablecoin"', async () => {
    const results = await svc.searchWeb('USDC stablecoin');
    console.log('[serper] top 3 results for "USDC stablecoin":');
    for (const r of results.slice(0, 3)) {
      console.log('  -', r.title, '→', r.link);
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/serper/`
Expected: FAIL.

- [ ] **Step 3: Implement `serper-service.ts`**

```ts
export interface SerperServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
  position?: number;
}

export class SerperService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: SerperServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://google.serper.dev';
  }

  async searchWeb(query: string): Promise<SerperOrganicResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) {
      throw new Error(`Serper request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { organic?: SerperOrganicResult[] };
    return body.organic ?? [];
  }
}
```

- [ ] **Step 4: Run live test**

Run: `npx vitest run src/providers/serper/`
Expected: PASS; top results logged. SKIPPED if key missing.

- [ ] **Step 5: Commit**

```bash
git add src/providers/serper/
git commit -m "feat(providers): add SerperService with live UNI/USDC search test"
```

---

## Task 7: Firecrawl provider (live)

**Files:**
- Create: `src/providers/firecrawl/firecrawl-service.ts`
- Create: `src/providers/firecrawl/firecrawl-service.live.test.ts`

- [ ] **Step 1: Write the failing live test**

`src/providers/firecrawl/firecrawl-service.live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FirecrawlService } from './firecrawl-service';

const apiKey = process.env.FIRECRAWL_API_KEY;

describe.skipIf(!apiKey)('FirecrawlService (live)', () => {
  const svc = new FirecrawlService({ apiKey: apiKey! });

  it('scrapes uniswap.org and returns markdown', async () => {
    const md = await svc.scrapeUrlMarkdown('https://uniswap.org');
    console.log('[firecrawl] uniswap.org markdown length:', md.length);
    console.log('[firecrawl] first 300 chars:\n', md.slice(0, 300));
    expect(md.length).toBeGreaterThan(100);
    expect(md.toLowerCase()).toContain('uniswap');
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/providers/firecrawl/`
Expected: FAIL.

- [ ] **Step 3: Implement `firecrawl-service.ts`**

```ts
export interface FirecrawlServiceOptions {
  apiKey: string;
  baseUrl?: string;
}

export class FirecrawlService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: FirecrawlServiceOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.firecrawl.dev';
  }

  async scrapeUrlMarkdown(url: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/scrape`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, formats: ['markdown'] }),
    });
    if (!res.ok) {
      throw new Error(`Firecrawl request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      success: boolean;
      data?: { markdown?: string };
      error?: string;
    };
    if (!body.success) {
      throw new Error(`Firecrawl returned error: ${body.error ?? 'unknown'}`);
    }
    const markdown = body.data?.markdown;
    if (typeof markdown !== 'string') {
      throw new Error('Firecrawl response missing markdown body');
    }
    return markdown;
  }
}
```

- [ ] **Step 4: Run live test**

Run: `npx vitest run src/providers/firecrawl/`
Expected: PASS; markdown length + preview logged. SKIPPED if key missing.

- [ ] **Step 5: Commit**

```bash
git add src/providers/firecrawl/
git commit -m "feat(providers): add FirecrawlService with live uniswap.org scrape test"
```

---

## Task 8: Empty Looper

**Files:**
- Create: `src/agent-looper/looper.ts`

No test in this slice — exercised end-to-end by `npm start` in Task 9.

- [ ] **Step 1: Implement `looper.ts`**

```ts
export interface LooperOptions {
  tickIntervalMs: number;
  onTick: () => Promise<void>;
}

export class Looper {
  private readonly tickIntervalMs: number;
  private readonly onTick: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LooperOptions) {
    this.tickIntervalMs = opts.tickIntervalMs;
    this.onTick = opts.onTick;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.onTick().catch((err) => {
        console.error('[Looper] tick error:', err);
      });
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/agent-looper/
git commit -m "feat(agent-looper): add empty Looper with start/stop"
```

---

## Task 9: `src/index.ts` entrypoint

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `src/index.ts` with the bootstrap**

```ts
import 'dotenv/config';
import { loadEnv } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';

function main(): void {
  const env = loadEnv();
  console.log(`[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      console.log(`[looper] tick @ ${new Date().toISOString()} — no agents loaded`);
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

main();
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Manually verify the empty loop runs**

Run: `npm start`
Expected output (within ~12 seconds, then Ctrl-C):
```
[bootstrap] env loaded — ZEROG_NETWORK=testnet, DB_DIR=./db
[bootstrap] looper started, ticking every 10000ms
[looper] tick @ 2026-04-26T...Z — no agents loaded
^C[bootstrap] received SIGINT, stopping looper
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire bootstrap entrypoint that starts an empty looper"
```

---

## Task 10: Full sweep + final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all four provider live tests pass and log their UNI/USDC payloads to the console; tests skip if their API key is absent.

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: exit code 0; `dist/` populated with compiled JS.

- [ ] **Step 3: Tag the slice**

```bash
git tag slice-1-bootstrap
```

- [ ] **Step 4: Verify directory structure matches the plan**

Run: `find src -type f | sort`
Expected:
```
src/agent-looper/looper.ts
src/config/env.ts
src/constants/index.ts
src/constants/looper.ts
src/constants/pools.ts
src/constants/tokens.ts
src/constants/unichain.ts
src/constants/zerog-networks.ts
src/index.ts
src/providers/coingecko/coingecko-service.live.test.ts
src/providers/coingecko/coingecko-service.ts
src/providers/coinmarketcap/coinmarketcap-service.live.test.ts
src/providers/coinmarketcap/coinmarketcap-service.ts
src/providers/firecrawl/firecrawl-service.live.test.ts
src/providers/firecrawl/firecrawl-service.ts
src/providers/serper/serper-service.live.test.ts
src/providers/serper/serper-service.ts
```

---

## Out of Scope for Slice 1

Deferred to later slices:
- `database/`, `agent-activity-log/`, `wallet/`, `agent-runner/`, `ai/`, `ai-tools/`, `uniswap/` modules
- Per-agent `intervalMs` gate logic — added in Slice 4 with `AgentRunner`
- `POOLS` content — filled in Slice 7
- Real swap tests under `INTERACTIVE_TESTS=1` — added in Slice 7

---

## Self-Review

**Spec coverage check:**
- ✅ Project setup, `.gitignore`, constants, providers, empty looper — all in tasks
- ✅ Per-provider live UNI/USDC test — Tasks 4–7, all `*.live.test.ts`, no mocks, console.log payloads
- ✅ Function naming convention — `fetchTokenPriceUSD`, `fetchTokenInfoBySymbol`, `searchWeb`, `scrapeUrlMarkdown`
- ✅ Modules as classes — every provider + Looper
- ✅ Constants module holds tick interval, addresses, chainIds, RPC URLs
- ✅ env validated via zod — Task 2
- ✅ Test rule honored — only providers/integrations have tests; env loader, constants, looper have none in this slice

**Placeholder scan:** No TBDs, no "implement later", no skipped code blocks.

**Type consistency:** `Looper` constructor and methods (`start`, `stop`, `isRunning`) used identically in `index.ts`. `loadEnv` signature consistent across impl + entrypoint. Provider service constructors all take `{ apiKey, baseUrl? }` shape.

# Token Allowlist + DB-Backed Token Catalog

**Status:** design approved · awaiting implementation plan
**Date:** 2026-04-30
**Predecessor:** [2026-04-26 agent loop foundation](2026-04-26-agent-loop-foundation-design.md)

## Goal

Replace the hardcoded `TOKENS` constant (UNI + USDC) with a database-backed token catalog seeded from CoinGecko. Give each agent an explicit allowlist of tokens it can trade, validated server-side against the catalog. Add AI tools for token lookup and decimal-aware utility math. Fix the LLM-decimals bug at the swap-tool boundary by accepting human-decimal amounts and resolving decimals server-side.

## Motivation

Three forces converge:

1. **Catalog scale.** Hardcoded TOKENS does not scale beyond two tokens. Operators want agents that can trade arbitrary Unichain tokens without code edits. The CoinGecko Unichain list (already seeded into the `Token` table) is the canonical catalog for v1.
2. **Per-agent security boundary.** Today every agent can swap any token if a developer wires the symbol. With a DB catalog and no allowlist, an agent owner could prompt-inject an LLM into trading anything in the catalog. We want owner-curated trading scope, validated against the catalog (so owners cannot allowlist phantom addresses).
3. **LLM decimal arithmetic is unreliable.** A real run produced `amountIn: "100000000000000000"` (18 decimals) for USDC (6 decimals) because the LLM guessed wrong. Risk gate caught it (`99,983,100,000 USD` vs `100 USD` cap), but the bug is structural: any time the LLM does decimal math on raw bigints we are one prompt away from a near-miss. Move the math server-side.

## Non-goals

- Multi-chain agent trading. Unichain (chainId 130) only for v1.
- Admin-curated `Token.tradingEnabled` flag (defense against rug-pull tokens that ARE on the CoinGecko list). Deferred to a future spec.
- Per-tool token allowlists. v1 has a single per-agent allowlist enforced at the swap boundary only.
- UI work. UI consumes the new endpoints; this spec covers backend only.

## Architecture

### Schema changes

```prisma
model Agent {
  // ...existing fields
  allowedTokens  String[]   // lowercased Unichain addresses, [] = no trading
}

model Token {
  // ...existing fields
  coingeckoId  String?      // populated by enriched seed (nullable for tokens missing from CoinGecko coin list)
}
```

Single migration: `add_agent_allowed_tokens_and_token_coingecko_id`. New agents default to `allowedTokens: []` — owners must opt in via UI before the agent can trade. No backfill of `allowedTokens` for existing agents (they freeze until owners pick a list, matching the explicit-opt-in invariant).

### Constants refactor

[src/constants/tokens.ts](../../../src/constants/tokens.ts) rewritten:

```ts
export const USDC_ON_UNICHAIN = {
  address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6' as `0x${string}`,
  decimals: 6,
  symbol: 'USDC',
  coingeckoId: 'usd-coin',
} as const;

export const UNI_ON_UNICHAIN = {
  address: '0x8f187aA05619a017077f5308904739877ce9eA21' as `0x${string}`,
  decimals: 18,
  symbol: 'UNI',
  coingeckoId: 'uniswap',
} as const;

// ZEROG_NATIVE_TOKEN, USDCE_ON_ZEROG, W0G_ON_ZEROG — unchanged
```

`TOKENS` and `TokenSymbol` are deleted. The two remaining constants serve infrastructure callsites where the token is hardcoded by design (treasury payment token, stable detection).

**Callsite migration:**

| File | Change |
|------|--------|
| [src/api-server/routes/treasury.ts](../../../src/api-server/routes/treasury.ts) | `TOKENS.USDC` → `USDC_ON_UNICHAIN` |
| [src/treasury/treasury-wallet.ts](../../../src/treasury/treasury-wallet.ts) | `TOKENS.USDC` → `USDC_ON_UNICHAIN` |
| [src/treasury/treasury-funds-watcher.ts](../../../src/treasury/treasury-funds-watcher.ts) | `TOKENS.USDC` → `USDC_ON_UNICHAIN` |
| [src/balance/balance-service.ts](../../../src/balance/balance-service.ts) | `TOKENS.USDC` → `USDC_ON_UNICHAIN` |
| [src/uniswap/position-tracker.ts](../../../src/uniswap/position-tracker.ts) | `STABLE_TOKEN_ADDRESSES` set built from `[USDC_ON_UNICHAIN.address.toLowerCase()]` |
| [src/ai-tools/uniswap/uniswap-swap-tool.ts](../../../src/ai-tools/uniswap/uniswap-swap-tool.ts) | TOKENS lookup → `TokenRepository` lookup; address-based input |
| [src/ai-tools/uniswap/uniswap-quote-tool.ts](../../../src/ai-tools/uniswap/uniswap-quote-tool.ts) | TOKENS lookup → `TokenRepository` lookup; address-based input |
| [src/ai-tools/providers/coingecko-price-tool.ts](../../../src/ai-tools/providers/coingecko-price-tool.ts) | TOKENS lookup → `TokenRepository` lookup; takes `coingeckoId` or `tokenAddress` |
| `scripts/lib/seed-uni-ma-trader.ts` | `buildSeedAgentConfig` sets `allowedTokens: [USDC_ON_UNICHAIN.address.toLowerCase(), UNI_ON_UNICHAIN.address.toLowerCase()]` |
| All test fixtures using `TOKENS.USDC`/`TOKENS.UNI` | Replace with `USDC_ON_UNICHAIN`/`UNI_ON_UNICHAIN` |

### TokenRepository

New repository at `src/database/repositories/token-repository.ts`:

```ts
export interface TokenRepository {
  findByAddress(address: string, chainId: number): Promise<Token | null>;
  findManyByAddresses(addresses: string[], chainId: number): Promise<Token[]>;
  findBySymbol(symbol: string, chainId: number): Promise<Token[]>;  // multiple matches possible
  list(opts: {
    chainId?: number;
    symbol?: string;
    search?: string;        // matches symbol or name (case-insensitive)
    cursor?: string;        // base64-encoded { id }
    limit: number;          // default 100, max 500
  }): Promise<{ tokens: Token[]; nextCursor: string | null }>;
}
```

Prisma impl mirrors existing repository pattern. Address inputs lowercased before query.

### AI tools surface

New tools in `ToolRegistry`:

**Token info**
- `findTokensBySymbol({ symbol })` — DB query on `(chainId=130, symbol)`. Returns `Token[]` (multiple matches expected; LLM disambiguates by name/address).
- `getTokenByAddress({ address })` — DB lookup on `(chainId=130, address.toLowerCase())`. Returns `Token | null`.
- `listAllowedTokens()` — joins `agent.allowedTokens` to Token rows. Returns `Token[]`. No args. Tells LLM what it can trade.

**Utility**
- `formatTokenAmount({ rawAmount, decimals })` — `BigInt(rawAmount)` → human decimal string via viem `formatUnits`.
- `parseTokenAmount({ humanAmount, decimals })` — human decimal → bigint string via viem `parseUnits`.

**Modified swap/quote (decimals bug fix)**

Swap tool input becomes:

```ts
{
  tokenInAddress: string,           // 0x-prefixed
  tokenOutAddress: string,          // 0x-prefixed
  amountIn: string,                 // human decimal, e.g. "0.01"
  slippageBps?: number,
  feeTier?: 500 | 3000 | 10000,
}
```

Server flow:
1. Lowercase + validate both addresses.
2. **Allowlist gate:** reject if either not in `agent.allowedTokens`. Error: `token <addr> not in agent allowlist`.
3. Resolve `Token` rows via `TokenRepository.findManyByAddresses`. Reject if either token unknown. Error: `token <addr> not in catalog`.
4. Parse `amountIn` (human decimal) using token's `decimals` → raw bigint.
5. Existing flow: quote → USD math → maxTradeUSD/maxSlippageBps gates → swap.

Quote tool input mirrors swap (address + human decimal). No allowlist enforcement — research is open per Q7.

**Coingecko price tool** input:

```ts
{
  coingeckoId?: string,
  tokenAddress?: string,            // resolved via TokenRepository → coingeckoId
}
```

Exactly one of `coingeckoId` / `tokenAddress` required. Symbol-based lookup is dropped — LLM uses `findTokensBySymbol` first when working from a symbol.

**Balance tool augmentation**

Both `getNativeBalance` and `getTokenBalance` return enriched payload:

```ts
// getNativeBalance
{ raw: string, formatted: string, decimals: 18, symbol: "ETH" }

// getTokenBalance
{ tokenAddress: string, raw: string, formatted: string, decimals: number, symbol: string }
```

`getTokenBalance` resolves `decimals` + `symbol` via `TokenRepository`. If address not in catalog, falls back to ERC-20 on-chain `decimals()` + `symbol()` reads, returns `symbol: '<unknown>'` if those fail. The enriched shape removes a class of LLM mistakes (reading raw bigints, dropping zeros).

### API endpoints

All new + modified routes go through Privy auth middleware (`req.user` populated from bearer token).

#### `GET /tokens` (auth required)

Query parameters (all optional):
- `chainId` (number) — defaults to all chains; clients pass `130` for Unichain.
- `symbol` (string) — exact match.
- `search` (string) — substring match on symbol or name (case-insensitive).
- `cursor` (string) — opaque pagination cursor.
- `limit` (number, default 100, max 500).

Response:
```ts
{
  tokens: Token[],
  nextCursor: string | null,
}
```

`Token` shape (zod schema `TokenViewSchema`):
```ts
{
  id: number,
  chainId: number,
  chain: string,
  address: string,            // lowercased
  symbol: string,
  name: string,
  decimals: number,
  logoUri: string | null,
  coingeckoId: string | null,
}
```

Returns 401 if missing/invalid bearer.

#### `GET /agents/:id/allowed-tokens` (auth required)

Resolves `agent.allowedTokens` (lowercased addresses) to full `Token` rows. 404 if agent does not belong to caller (no 403, matching existing cross-user policy).

Response:
```ts
{ tokens: Token[] }
```

Tokens whose address is in `allowedTokens` but missing from the catalog are silently dropped — should not happen given write-side validation, but defensive.

#### `POST /agents` + `PATCH /agents/:id` (modified)

Body extended with optional `allowedTokens: string[]`.

Server validation flow:
1. Lowercase + dedupe.
2. `TokenRepository.findManyByAddresses(addrs, 130)`.
3. If `result.length !== addrs.length`, return 400:
   ```ts
   { error: 'unknown_tokens', unknownAddresses: string[] }
   ```
4. Persist.

`POST` with no `allowedTokens` defaults to `[]`. `PATCH` with `allowedTokens: undefined` leaves the column untouched; `PATCH` with `allowedTokens: []` clears it.

#### OpenAPI sync (mandatory per CLAUDE.md)

[src/api-server/openapi/schemas.ts](../../../src/api-server/openapi/schemas.ts):
- Add `TokenViewSchema`, `TokensListResponseSchema`, `AllowedTokensResponseSchema`, `UnknownTokensErrorSchema`.
- Extend `AgentConfigSchema`, `CreateAgentBodySchema`, `UpdateAgentBodySchema` with `allowedTokens: z.array(z.string()).optional()`.

[src/api-server/openapi/spec-builder.ts](../../../src/api-server/openapi/spec-builder.ts):
- Register `GET /tokens` (200 + 401).
- Register `GET /agents/{id}/allowed-tokens` (200 + 401 + 404).
- Update existing agent create/patch routes: include `allowedTokens` in request body, add 400 response with `UnknownTokensErrorSchema`.

### Seed enrichment

[prisma/seed-tokens.ts](../../../prisma/seed-tokens.ts) gains a CoinGecko coin-list step:

1. Fetch `https://api.coingecko.com/api/v3/coins/list?include_platform=true`. Cache to `./db/coingecko-coins-list.json` if absent or older than 24h (the response is ~10MB; do not re-download on every reseed).
2. Build map `address(unichain) → coingeckoId` by walking `coin.platforms.unichain` for each coin.
3. While upserting Unichain tokens from the existing token-list step, set `coingeckoId` from the map (null if missing — many tokens are not on CoinGecko's coin list).

Hardcoded constants (`USDC_ON_UNICHAIN.coingeckoId = 'usd-coin'`, `UNI_ON_UNICHAIN.coingeckoId = 'uniswap'`) act as a sanity-check reference; if the seed produces different IDs for these addresses, log a warning (data drift signal, not a hard error).

### Seed agent

`scripts/lib/seed-uni-ma-trader.ts` updated: `buildSeedAgentConfig` includes:

```ts
allowedTokens: [
  USDC_ON_UNICHAIN.address.toLowerCase(),
  UNI_ON_UNICHAIN.address.toLowerCase(),
],
```

Without this, the seed agent post-migration cannot trade and `npm run db:reset && npm start` becomes a silent no-op.

## Security model

| Threat | Mitigation |
|--------|------------|
| Owner allowlists a phantom/typo address | Server validates against `Token` table; 400 on unknown |
| LLM tries to swap a non-allowlisted token | Swap tool rejects pre-quote; error surfaces to agent loop |
| LLM swaps via symbol confusion (different tokens, same symbol) | Tool inputs are addresses only; symbol→address resolution is an explicit `findTokensBySymbol` step |
| LLM confuses decimals → catastrophic trade size | Swap takes human decimal; server resolves decimals from DB |
| Malicious tokens on CoinGecko list (rug-pulls) | **Not addressed in v1.** Owner curates via UI. Future spec adds admin-managed `Token.tradingEnabled`. |

## Migration order

1. Prisma migration: add `Agent.allowedTokens` (default `[]`) + `Token.coingeckoId` (nullable).
2. Update `seed-tokens.ts` with CoinGecko coin-list enrichment. Run `npm run db:seed` to populate `coingeckoId`.
3. Rewrite `src/constants/tokens.ts`. Migrate non-AI callsites (treasury, balance, position-tracker, tests).
4. Add `TokenRepository` + Prisma impl. Wire into `Database` facade.
5. Rewrite swap/quote/coingecko-price tools to use `TokenRepository` + address-based input. Update `wallet-balance-tools.ts` to enrich responses. Add new tools (`findTokensBySymbol`, `getTokenByAddress`, `listAllowedTokens`, `formatTokenAmount`, `parseTokenAmount`).
6. Add `/tokens` + `/users/me/agents/:id/allowed-tokens` routes. Extend agent create/patch with allowlist validation. Update OpenAPI schemas + spec-builder.
7. Update seed agent builder (`scripts/lib/seed-uni-ma-trader.ts`) with `allowedTokens`.
8. Tests: update fixtures, add live tests for new endpoints + new tools, add unit tests for utility tools.

## Backwards compatibility

None. Pre-migration agents get `allowedTokens=[]` and stop trading until owners set a list — explicit opt-in matches the design intent. The seed agent is updated in step 7 so `db:reset` flows continue working.

## Open questions

None at write time. All resolved during brainstorming (Q1–Q8).

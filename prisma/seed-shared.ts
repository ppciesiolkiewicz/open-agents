import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { USDC_ON_UNICHAIN, UNI_ON_UNICHAIN, WBTC_ON_UNICHAIN } from '../src/constants';

export const SEED_USER_EMAIL = 'ppciesiolkiewicz@gmail.com';
export const SEED_USER_DID = 'did:privy:cmojphu3700g40cieu3d6zmmc';

const CHAIN_ID_TO_NAME: Record<number, string> = { 130: 'unichain' };
const TOKEN_LIST_URLS: Record<string, string> = {
  unichain: 'https://tokens.coingecko.com/unichain/all.json',
};
const COINGECKO_COINS_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const COINGECKO_CACHE_PATH = path.resolve(process.cwd(), 'db', 'coingecko-coins-list.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CoinGeckoToken {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

interface CoinGeckoTokenList {
  tokens: CoinGeckoToken[];
}

interface CoinGeckoCoin {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string | null>;
}

async function fetchTokenList(url: string): Promise<CoinGeckoToken[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch token list: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as CoinGeckoTokenList;
  return data.tokens;
}

async function loadCoingeckoCoinList(): Promise<CoinGeckoCoin[]> {
  try {
    const stat = await fs.stat(COINGECKO_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
      const buf = await fs.readFile(COINGECKO_CACHE_PATH, 'utf8');
      return JSON.parse(buf) as CoinGeckoCoin[];
    }
  } catch {
    // cache miss
  }
  console.log(`[seed] fetching CoinGecko coin list (~10MB) from ${COINGECKO_COINS_LIST_URL}...`);
  const res = await fetch(COINGECKO_COINS_LIST_URL);
  if (!res.ok) throw new Error(`coins/list failed: ${res.status} ${res.statusText}`);
  const list = (await res.json()) as CoinGeckoCoin[];
  await fs.mkdir(path.dirname(COINGECKO_CACHE_PATH), { recursive: true });
  await fs.writeFile(COINGECKO_CACHE_PATH, JSON.stringify(list));
  return list;
}

function buildAddressToCoingeckoId(coins: CoinGeckoCoin[], platformKey: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const coin of coins) {
    const addr = coin.platforms?.[platformKey];
    if (addr) map.set(addr.toLowerCase(), coin.id);
  }
  return map;
}

export async function seedFullTokenCatalog(prisma: PrismaClient): Promise<void> {
  const coins = await loadCoingeckoCoinList();
  for (const [chain, url] of Object.entries(TOKEN_LIST_URLS)) {
    console.log(`[seed] fetching ${chain} token list...`);
    const tokens = await fetchTokenList(url);
    console.log(`[seed] ${tokens.length} tokens fetched`);

    const idMap = buildAddressToCoingeckoId(coins, chain);
    console.log(`[seed] ${idMap.size} ${chain} addresses have a coingeckoId`);

    let upserted = 0;
    for (const token of tokens) {
      const chainName = CHAIN_ID_TO_NAME[token.chainId] ?? chain;
      const lowerAddr = token.address.toLowerCase();
      const coingeckoId = idMap.get(lowerAddr) ?? null;
      await prisma.token.upsert({
        where: { address_chainId: { address: lowerAddr, chainId: token.chainId } },
        update: {
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoUri: token.logoURI ?? null,
          chain: chainName,
          coingeckoId,
        },
        create: {
          chainId: token.chainId,
          chain: chainName,
          address: lowerAddr,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoUri: token.logoURI ?? null,
          coingeckoId,
        },
      });
      upserted++;
    }
    console.log(`[seed] upserted ${upserted} tokens for chain "${chain}"`);
  }
}

export const CANONICAL_TOKENS = [
  {
    chainId: 130,
    chain: 'unichain',
    address: USDC_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    coingeckoId: USDC_ON_UNICHAIN.coingeckoId,
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: UNI_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    coingeckoId: UNI_ON_UNICHAIN.coingeckoId,
  },
  {
    chainId: 130,
    chain: 'unichain',
    address: WBTC_ON_UNICHAIN.address.toLowerCase(),
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    coingeckoId: WBTC_ON_UNICHAIN.coingeckoId,
  },
];

export async function upsertCanonicalTokens(prisma: PrismaClient): Promise<void> {
  for (const t of CANONICAL_TOKENS) {
    await prisma.token.upsert({
      where: { address_chainId: { address: t.address, chainId: t.chainId } },
      update: { symbol: t.symbol, name: t.name, decimals: t.decimals, chain: t.chain, coingeckoId: t.coingeckoId },
      create: t,
    });
  }
  console.log(`[seed] upserted ${CANONICAL_TOKENS.length} canonical tokens (USDC/UNI/WBTC)`);
}

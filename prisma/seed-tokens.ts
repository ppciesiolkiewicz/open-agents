import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const CHAIN_ID_TO_NAME: Record<number, string> = {
  130: 'unichain',
};

const TOKEN_LIST_URLS: Record<string, string> = {
  unichain: 'https://tokens.coingecko.com/unichain/all.json',
};

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

async function fetchTokenList(url: string): Promise<CoinGeckoToken[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch token list: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as CoinGeckoTokenList;
  return data.tokens;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const [chain, url] of Object.entries(TOKEN_LIST_URLS)) {
      console.log(`[seed-tokens] fetching ${chain} token list...`);
      const tokens = await fetchTokenList(url);
      console.log(`[seed-tokens] ${tokens.length} tokens fetched`);

      let upserted = 0;
      for (const token of tokens) {
        const chainName = CHAIN_ID_TO_NAME[token.chainId] ?? chain;
        await prisma.token.upsert({
          where: { address_chainId: { address: token.address.toLowerCase(), chainId: token.chainId } },
          update: {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUri: token.logoURI ?? null,
            chain: chainName,
          },
          create: {
            chainId: token.chainId,
            chain: chainName,
            address: token.address.toLowerCase(),
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUri: token.logoURI ?? null,
          },
        });
        upserted++;
      }

      console.log(`[seed-tokens] upserted ${upserted} tokens for chain "${chain}"`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-tokens] fatal:', err);
  process.exit(1);
});

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { CoingeckoService } from '../providers/coingecko/coingecko-service';
import { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from '../providers/serper/serper-service';
import { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';
import type { AxlClient } from '../axl/axl-client';

// Pure-logic test: verifies the canonical tool list is what the LLM sees.
// No I/O — services and DB are constructed but never called.
describe('ToolRegistry.build', () => {
  it('returns the expected 23 tools in order', () => {
    const registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'unused' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'unused' }),
      serper: new SerperService({ apiKey: 'unused' }),
      firecrawl: new FirecrawlService({ apiKey: 'unused' }),
      db: {} as Database,
      uniswap: {} as import('../uniswap/uniswap-service').UniswapService,
      env: { ALCHEMY_API_KEY: 'test', UNICHAIN_RPC_URL: undefined } as any,
      axlClient: {} as AxlClient,
      localAxlPeerId: 'test-peer-id',
    });
    const names = registry.build().map((t) => t.name);
    expect(names).toEqual([
      'fetchTokenPriceUSD',
      'fetchTokenInfoBySymbol',
      'searchWeb',
      'scrapeUrlMarkdown',
      'getWalletAddress',
      'getNativeBalance',
      'getTokenBalance',
      'transferERC20Token',
      'readMemory',
      'updateMemory',
      'saveMemoryEntry',
      'searchMemoryEntries',
      'getUniswapQuoteExactIn',
      'executeUniswapSwapExactIn',
      'findTokensBySymbol',
      'getTokenByAddress',
      'listAllowedTokens',
      'sendMessageToAgentHelp',
      'sendMessageToAgent',
      'listAvailableChannels',
      'sendMessageToChannel',
      'formatTokenAmount',
      'parseTokenAmount',
    ]);
  });

  it('every tool has a non-empty description and a zod input schema', () => {
    const registry = new ToolRegistry({
      coingecko: new CoingeckoService({ apiKey: 'unused' }),
      coinmarketcap: new CoinMarketCapService({ apiKey: 'unused' }),
      serper: new SerperService({ apiKey: 'unused' }),
      firecrawl: new FirecrawlService({ apiKey: 'unused' }),
      db: {} as Database,
      uniswap: {} as import('../uniswap/uniswap-service').UniswapService,
      env: { ALCHEMY_API_KEY: 'test', UNICHAIN_RPC_URL: undefined } as any,
      axlClient: {} as AxlClient,
      localAxlPeerId: 'test-peer-id',
    });
    for (const tool of registry.build()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema.parse).toBe('function');
    }
  });
});

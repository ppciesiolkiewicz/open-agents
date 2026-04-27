import type { AgentTool } from './tool';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import type { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import type { SerperService } from '../providers/serper/serper-service';
import type { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';
import { buildCoingeckoPriceTool } from './providers/coingecko-price-tool';
import { buildCoinMarketCapInfoTool } from './providers/coinmarketcap-info-tool';
import { buildSerperSearchTool } from './providers/serper-search-tool';
import { buildFirecrawlScrapeTool } from './providers/firecrawl-scrape-tool';
import { buildWalletBalanceTools } from './wallet/wallet-balance-tools';
import { buildReadMemoryTool } from './memory/read-memory-tool';
import { buildUpdateMemoryTool } from './memory/update-memory-tool';
import { buildSaveMemoryEntryTool } from './memory/save-memory-entry-tool';
import { buildSearchMemoryEntriesTool } from './memory/search-memory-entries-tool';

export interface ToolRegistryDeps {
  coingecko: CoingeckoService;
  coinmarketcap: CoinMarketCapService;
  serper: SerperService;
  firecrawl: FirecrawlService;
  db: Database;
}

export class ToolRegistry {
  constructor(private readonly deps: ToolRegistryDeps) {}

  // All tools are stateless w.r.t. the agent — agent context flows in per-call
  // via AgentToolContext. The list itself can be reused across agents.
  build(): AgentTool[] {
    const [nativeBalance, tokenBalance] = buildWalletBalanceTools();
    return [
      buildCoingeckoPriceTool(this.deps.coingecko),
      buildCoinMarketCapInfoTool(this.deps.coinmarketcap),
      buildSerperSearchTool(this.deps.serper),
      buildFirecrawlScrapeTool(this.deps.firecrawl),
      nativeBalance,
      tokenBalance,
      buildReadMemoryTool(this.deps.db),
      buildUpdateMemoryTool(this.deps.db),
      buildSaveMemoryEntryTool(this.deps.db),
      buildSearchMemoryEntriesTool(this.deps.db),
    ];
  }
}

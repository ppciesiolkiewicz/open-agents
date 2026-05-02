import type { AgentTool } from './tool';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import type { CoinMarketCapService } from '../providers/coinmarketcap/coinmarketcap-service';
import type { SerperService } from '../providers/serper/serper-service';
import type { FirecrawlService } from '../providers/firecrawl/firecrawl-service';
import type { Database } from '../database/database';
import type { UniswapService } from '../uniswap/uniswap-service';
import type { Env } from '../config/env';
import type { AxlClient } from '../axl/axl-client';
import { buildCoingeckoPriceTool } from './providers/coingecko-price-tool';
import { buildCoinMarketCapInfoTool } from './providers/coinmarketcap-info-tool';
import { buildSerperSearchTool } from './providers/serper-search-tool';
import { buildFirecrawlScrapeTool } from './providers/firecrawl-scrape-tool';
import { buildWalletBalanceTools } from './wallet/wallet-balance-tools';
import { buildReadMemoryTool } from './memory/read-memory-tool';
import { buildUpdateMemoryTool } from './memory/update-memory-tool';
import { buildSaveMemoryEntryTool } from './memory/save-memory-entry-tool';
import { buildSearchMemoryEntriesTool } from './memory/search-memory-entries-tool';
import { buildUniswapQuoteTool } from './uniswap/uniswap-quote-tool';
import { buildUniswapSwapTool } from './uniswap/uniswap-swap-tool';
import { buildFindTokensBySymbolTool } from './tokens/find-tokens-by-symbol-tool';
import { buildGetTokenByAddressTool } from './tokens/get-token-by-address-tool';
import { buildListAllowedTokensTool } from './tokens/list-allowed-tokens-tool';
import { buildFormatTokenAmountTool } from './utility/format-token-amount-tool';
import { buildParseTokenAmountTool } from './utility/parse-token-amount-tool';
import { buildSendMessageToAgentTool } from './axl/send-message-to-agent-tool';
import { buildSendMessageToAgentHelpTool } from './axl/send-message-to-agent-help-tool';
import { buildSendMessageToChannelTool } from './axl/send-message-to-channel-tool';
import { buildListAvailableChannelsTool } from './axl/list-available-channels-tool';
import { assertToolCatalogMatchesBuiltTools } from './tool-catalog';

export interface ToolRegistryDeps {
  coingecko: CoingeckoService;
  coinmarketcap: CoinMarketCapService;
  serper: SerperService;
  firecrawl: FirecrawlService;
  db: Database;
  uniswap: UniswapService;
  env: Env;
  axlClient: AxlClient;
  localAxlPeerId: string;
}

export class ToolRegistry {
  constructor(private readonly deps: ToolRegistryDeps) {}

  build(): AgentTool[] {
    const [walletAddress, nativeBalance, tokenBalance] = buildWalletBalanceTools(this.deps.db, this.deps.env);
    const tools = [
      buildCoingeckoPriceTool(this.deps.coingecko, this.deps.db),
      buildCoinMarketCapInfoTool(this.deps.coinmarketcap),
      buildSerperSearchTool(this.deps.serper),
      buildFirecrawlScrapeTool(this.deps.firecrawl),
      walletAddress,
      nativeBalance,
      tokenBalance,
      buildReadMemoryTool(this.deps.db),
      buildUpdateMemoryTool(this.deps.db),
      buildSaveMemoryEntryTool(this.deps.db),
      buildSearchMemoryEntriesTool(this.deps.db),
      buildUniswapQuoteTool(this.deps.uniswap, this.deps.db),
      buildUniswapSwapTool(this.deps.uniswap, this.deps.coingecko, this.deps.db),
      buildFindTokensBySymbolTool(this.deps.db),
      buildGetTokenByAddressTool(this.deps.db),
      buildListAllowedTokensTool(this.deps.db),
      buildSendMessageToAgentHelpTool(this.deps.db),
      buildSendMessageToAgentTool(this.deps.db, this.deps.axlClient, this.deps.localAxlPeerId),
      buildListAvailableChannelsTool(this.deps.db),
      buildSendMessageToChannelTool(this.deps.db, this.deps.axlClient, this.deps.localAxlPeerId),
      buildFormatTokenAmountTool(),
      buildParseTokenAmountTool(),
    ];
    assertToolCatalogMatchesBuiltTools(tools);
    return tools;
  }
}

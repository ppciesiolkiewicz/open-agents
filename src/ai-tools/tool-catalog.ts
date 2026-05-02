import type { AgentTool } from './tool';

export interface ToolCatalogItem {
  id: string;
  name: string;
  callableName: string;
  description: string;
  category?: string;
}

export const TOOL_CATALOG: ToolCatalogItem[] = [
  { id: 'market.coingecko.price', name: 'Get token price', callableName: 'fetchTokenPriceUSD', description: 'Fetch token USD price by Coingecko id', category: 'market' },
  { id: 'market.coinmarketcap.info', name: 'Get token info by symbol', callableName: 'fetchTokenInfoBySymbol', description: 'Fetch token info by symbol from CoinMarketCap', category: 'market' },
  { id: 'search.web', name: 'Search web', callableName: 'searchWeb', description: 'Search the web for recent information', category: 'search' },
  { id: 'web.scrape.markdown', name: 'Scrape URL markdown', callableName: 'scrapeUrlMarkdown', description: 'Scrape a URL and return markdown content', category: 'web' },
  { id: 'wallet.address.get', name: 'Get wallet address', callableName: 'getWalletAddress', description: 'Get current agent wallet address', category: 'wallet' },
  { id: 'wallet.balance.native.get', name: 'Get native balance', callableName: 'getNativeBalance', description: 'Get native token balance for current wallet', category: 'wallet' },
  { id: 'wallet.balance.token.get', name: 'Get token balance', callableName: 'getTokenBalance', description: 'Get ERC-20 token balance for current wallet', category: 'wallet' },
  { id: 'memory.read', name: 'Read memory', callableName: 'readMemory', description: 'Read persistent agent memory state, notes, and recent entries', category: 'memory' },
  { id: 'memory.update', name: 'Update memory', callableName: 'updateMemory', description: 'Update persistent agent memory state and notes', category: 'memory' },
  { id: 'memory.entry.save', name: 'Save memory entry', callableName: 'saveMemoryEntry', description: 'Append a memory entry for the current tick', category: 'memory' },
  { id: 'memory.entry.search', name: 'Search memory entries', callableName: 'searchMemoryEntries', description: 'Search memory entries by query text', category: 'memory' },
  { id: 'uniswap.quote.exact-in', name: 'Get Uniswap quote', callableName: 'getUniswapQuoteExactIn', description: 'Get Uniswap quote for exact-in swap', category: 'uniswap' },
  { id: 'uniswap.swap.exact-in', name: 'Execute Uniswap swap', callableName: 'executeUniswapSwapExactIn', description: 'Execute Uniswap exact-in swap', category: 'uniswap' },
  { id: 'tokens.find-by-symbol', name: 'Find tokens by symbol', callableName: 'findTokensBySymbol', description: 'Find supported tokens by symbol', category: 'tokens' },
  { id: 'tokens.get-by-address', name: 'Get token by address', callableName: 'getTokenByAddress', description: 'Get supported token by address', category: 'tokens' },
  { id: 'tokens.list-allowed', name: 'List allowed tokens', callableName: 'listAllowedTokens', description: 'List this agent allowed token set', category: 'tokens' },
  { id: 'agents.message.help', name: 'Agent messaging help', callableName: 'sendMessageToAgentHelp', description: 'Explain agent-to-agent messaging usage', category: 'agents' },
  { id: 'agents.message.send', name: 'Send message to agent', callableName: 'sendMessageToAgent', description: 'Send a message to another connected agent', category: 'agents' },
  { id: 'agents.channels.list', name: 'List available channels', callableName: 'listAvailableChannels', description: 'List AXL channels this agent is connected to and can message', category: 'agents' },
  { id: 'agents.channel-message.send', name: 'Send message to channel', callableName: 'sendMessageToChannel', description: 'Send a message to all other agents in a connected channel', category: 'agents' },
  { id: 'utility.token-amount.format', name: 'Format token amount', callableName: 'formatTokenAmount', description: 'Format raw token amount using decimals', category: 'utility' },
  { id: 'utility.token-amount.parse', name: 'Parse token amount', callableName: 'parseTokenAmount', description: 'Parse human token amount into raw units', category: 'utility' },
];

const TOOL_CALLABLE_NAME_BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool.callableName]));
const TOOL_BY_ID = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
const TOOL_BY_CALLABLE_NAME = new Map(TOOL_CATALOG.map((tool) => [tool.callableName, tool]));

export const SUPPORTED_TOOL_IDS = TOOL_CATALOG.map((tool) => tool.id);

export function listAllToolCatalogItems(): ToolCatalogItem[] {
  return TOOL_CATALOG;
}

export function listAllSupportedToolIds(): string[] {
  return SUPPORTED_TOOL_IDS;
}

export function validateAndNormalizeToolIds(ids: string[]): {
  normalizedToolIds: string[];
  unknownToolIds: string[];
} {
  const normalized: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!TOOL_BY_ID.has(id)) {
      unknown.push(id);
      continue;
    }
    normalized.push(id);
  }
  return { normalizedToolIds: normalized, unknownToolIds: unknown };
}

export function selectToolsByIds(tools: AgentTool[], toolIds: string[]): AgentTool[] {
  const names = new Set(
    toolIds
      .map((id) => TOOL_CALLABLE_NAME_BY_ID.get(id))
      .filter((name): name is string => name !== undefined),
  );
  return tools.filter((tool) => names.has(tool.name));
}

export function assertToolCatalogMatchesBuiltTools(tools: AgentTool[]): void {
  const missingInCatalog = tools
    .map((tool) => tool.name)
    .filter((name) => !TOOL_BY_CALLABLE_NAME.has(name));
  const missingInBuild = TOOL_CATALOG
    .map((tool) => tool.callableName)
    .filter((name) => !tools.some((tool) => tool.name === name));
  if (missingInCatalog.length > 0 || missingInBuild.length > 0) {
    throw new Error(
      `tool catalog mismatch (missingInCatalog=${JSON.stringify(missingInCatalog)} missingInBuild=${JSON.stringify(missingInBuild)})`,
    );
  }
}

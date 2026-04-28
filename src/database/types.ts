export interface TokenAmount {
  tokenAddress: string;
  symbol: string;
  amountRaw: string;            // bigint as string
  decimals: number;
}

export type AgentType = 'scheduled' | 'chat';

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  enabled: boolean;
  intervalMs: number;
  prompt: string;
  walletAddress: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;  // tokenAddr (or "native") → raw bigint string
  riskLimits: {
    maxTradeUSD: number;       // existing
    maxSlippageBps: number;    // new — agent's ceiling on slippage tolerance (50 = 0.5%, 100 = 1%)
    [k: string]: unknown;
  };
  lastTickAt: number | null;
  lastMessageAt?: number | null;
  createdAt: number;
}

export interface Transaction {
  id: string;
  agentId: string;
  hash: string;                 // real 0x-prefixed hash, or dry-run sentinel
  chainId: number;
  from: string;
  to: string;
  tokenIn?: TokenAmount;
  tokenOut?: TokenAmount;
  gasUsed: string;              // bigint as string; estimated for dry-run
  gasPriceWei: string;          // bigint as string
  gasCostWei: string;           // bigint as string; gasUsed * gasPriceWei
  status: 'pending' | 'success' | 'failed';
  blockNumber: number | null;   // null for dry-run
  timestamp: number;
}

export interface Position {
  id: string;
  agentId: string;
  amount: TokenAmount;
  costBasisUSD: number;
  openedByTransactionId: string;
  closedByTransactionId?: string;
  openedAt: number;
  closedAt: number | null;
  realizedPnlUSD: number | null;
}

export type MemoryEntryType = 'snapshot' | 'observation' | 'gist' | 'note';

export interface MemoryEntry {
  id: string;
  tickId: string;
  type: MemoryEntryType;
  content: string;
  parentEntryIds?: string[];   // a 'gist' may reference the entries it summarizes
  embedding?: number[];        // reserved for future similarity search; null/absent in v1
  createdAt: number;
}

export interface AgentMemory {
  agentId: string;
  notes: string;
  state: Record<string, unknown>;
  updatedAt: number;
  entries: MemoryEntry[];      // append-only history; populated by saveMemoryEntry tool
}

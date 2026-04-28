export interface TokenAmount {
  tokenAddress: string;
  symbol: string;
  amountRaw: string;            // bigint as string
  decimals: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  prompt: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;  // tokenAddr (or "native") → raw bigint string
  riskLimits: {
    maxTradeUSD: number;
    maxSlippageBps: number;
    [k: string]: unknown;
  };
  createdAt: number;
  // optional schedule
  running?: boolean;
  intervalMs?: number;
  lastTickAt?: number | null;
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

export type AgentActivityLogEntryType =
  | 'user_message'
  | 'tick_start'
  | 'tick_end'
  | 'tool_call'
  | 'tool_result'
  | 'llm_call'
  | 'llm_response'
  | 'memory_update'
  | 'error';

export interface AgentActivityLogEntryInput {
  agentId: string;
  tickId: string;
  timestamp: number;
  type: AgentActivityLogEntryType;
  payload: Record<string, unknown>;
}

export interface AgentActivityLogEntry extends AgentActivityLogEntryInput {
  seq: number;
}

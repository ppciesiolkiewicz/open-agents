export interface TokenAmount {
  tokenAddress: string;
  symbol: string;
  amountRaw: string;            // bigint as string
  decimals: number;
}

export interface AgentConfig {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  dryRun: boolean;
  dryRunSeedBalances?: Record<string, string>;  // tokenAddr (or "native") → raw bigint string
  allowedTokens: string[];
  toolIds?: string[];
  connectedAgentIds?: string[];
  connectedChannelIds?: string[];
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
  axlPeerId?: string | null;
}

export interface AxlChannel {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  memberAgentIds: string[];
}

export interface Transaction {
  id: string;
  agentId: string;
  hash: string;                 // real 0x-prefixed hash, or dry-run sentinel
  chainId: number;
  fromAddress: string;
  toAddress: string;
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

export interface User {
  id: string;
  privyDid: string;
  email: string | null;
  createdAt: number;
}

export interface UserWallet {
  id: string;
  userId: string;
  privyWalletId: string;
  walletAddress: string;
  isPrimary: boolean;
  createdAt: number;
}

export type ZeroGPurchaseStatus =
  | 'pending'
  | 'swapping'
  | 'sending'
  | 'topping_up'
  | 'completed'
  | 'failed';

export interface ZeroGPurchase {
  id: string;
  userId: string;
  userWalletAddress: string;

  incomingTxHash: string;
  incomingUsdcAmount: string;

  serviceFeeUsdcAmount: string;
  swapInputUsdcAmount: string;

  swapTxHash?: string;
  swapInputUsdceAmount?: string;
  swapOutputW0gAmount?: string;
  swapGasCostWei?: string;

  unwrapTxHash?: string;
  unwrapGasCostWei?: string;
  unwrappedOgAmount?: string;

  sendTxHash?: string;
  sendGasCostWei?: string;
  ogAmountSentToUser?: string;

  ledgerTopUpTxHash?: string;
  ledgerTopUpGasCostWei?: string;

  status: ZeroGPurchaseStatus;
  errorMessage?: string;

  createdAt: number;
  updatedAt: number;
}

export interface Token {
  id: number;
  chainId: number;
  chain: string;
  address: string;          // lowercased
  symbol: string;
  name: string;
  decimals: number;
  logoUri: string | null;
  coingeckoId: string | null;
}

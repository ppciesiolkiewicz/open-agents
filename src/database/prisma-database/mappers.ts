import type {
  Agent as PrismaAgent,
  Transaction as PrismaTransaction,
  Position as PrismaPosition,
  AgentMemory as PrismaAgentMemory,
  MemoryEntry as PrismaMemoryEntry,
  ActivityEvent as PrismaActivityEvent,
  User as PrismaUser,
  UserWallet as PrismaUserWallet,
  Token as PrismaToken,
} from '@prisma/client';
import type {
  AgentConfig,
  Transaction,
  Position,
  AgentMemory,
  MemoryEntry,
  TokenAmount,
  AgentActivityLogEntry,
  User,
  UserWallet,
  Token,
} from '../types';

const num = (v: bigint | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

const numReq = (v: bigint): number => Number(v);

export function agentRowToDomain(row: PrismaAgent): AgentConfig {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    prompt: row.prompt,
    dryRun: row.dryRun,
    dryRunSeedBalances: (row.dryRunSeedBalances ?? undefined) as
      | Record<string, string>
      | undefined,
    allowedTokens: row.allowedTokens,
    toolIds: row.toolIds,
    connectedAgentIds: [],
    riskLimits: row.riskLimits as AgentConfig['riskLimits'],
    createdAt: numReq(row.createdAt),
    running: row.running ?? undefined,
    intervalMs: row.intervalMs ?? undefined,
    lastTickAt: num(row.lastTickAt),
  };
}

export function txRowToDomain(row: PrismaTransaction): Transaction {
  return {
    id: row.id,
    agentId: row.agentId,
    hash: row.hash,
    chainId: row.chainId,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    tokenIn: (row.tokenIn ?? undefined) as TokenAmount | undefined,
    tokenOut: (row.tokenOut ?? undefined) as TokenAmount | undefined,
    gasUsed: row.gasUsed,
    gasPriceWei: row.gasPriceWei,
    gasCostWei: row.gasCostWei,
    status: row.status as Transaction['status'],
    blockNumber: num(row.blockNumber),
    timestamp: numReq(row.timestamp),
  };
}

export function txDomainToCreate(t: Transaction): Omit<PrismaTransaction, never> {
  return {
    id: t.id,
    agentId: t.agentId,
    hash: t.hash,
    chainId: t.chainId,
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    tokenIn: (t.tokenIn ?? null) as PrismaTransaction['tokenIn'],
    tokenOut: (t.tokenOut ?? null) as PrismaTransaction['tokenOut'],
    gasUsed: t.gasUsed,
    gasPriceWei: t.gasPriceWei,
    gasCostWei: t.gasCostWei,
    status: t.status,
    blockNumber: t.blockNumber === null ? null : BigInt(t.blockNumber),
    timestamp: BigInt(t.timestamp),
  };
}

export function positionRowToDomain(row: PrismaPosition): Position {
  return {
    id: row.id,
    agentId: row.agentId,
    amount: row.amount as unknown as TokenAmount,
    costBasisUSD: row.costBasisUSD,
    openedByTransactionId: row.openedByTransactionId,
    closedByTransactionId: row.closedByTransactionId ?? undefined,
    openedAt: numReq(row.openedAt),
    closedAt: num(row.closedAt),
    realizedPnlUSD: row.realizedPnlUSD,
  };
}

export function positionDomainToRow(p: Position): Omit<PrismaPosition, never> {
  return {
    id: p.id,
    agentId: p.agentId,
    amount: p.amount as unknown as PrismaPosition['amount'],
    costBasisUSD: p.costBasisUSD,
    openedByTransactionId: p.openedByTransactionId,
    closedByTransactionId: p.closedByTransactionId ?? null,
    openedAt: BigInt(p.openedAt),
    closedAt: p.closedAt === null ? null : BigInt(p.closedAt),
    realizedPnlUSD: p.realizedPnlUSD,
  };
}

export function memoryEntryRowToDomain(row: PrismaMemoryEntry): MemoryEntry {
  return {
    id: row.id,
    tickId: row.tickId,
    type: row.type as MemoryEntry['type'],
    content: row.content,
    parentEntryIds: row.parentEntryIds.length > 0 ? row.parentEntryIds : undefined,
    createdAt: numReq(row.createdAt),
  };
}

export function memoryRowToDomain(
  row: PrismaAgentMemory & { entries: PrismaMemoryEntry[] },
): AgentMemory {
  return {
    agentId: row.agentId,
    notes: row.notes,
    state: row.state as Record<string, unknown>,
    updatedAt: numReq(row.updatedAt),
    entries: row.entries.map(memoryEntryRowToDomain),
  };
}

export function activityEventRowToDomain(row: PrismaActivityEvent): AgentActivityLogEntry {
  return {
    agentId: row.agentId,
    tickId: row.tickId ?? '',
    timestamp: numReq(row.timestamp),
    type: row.type as AgentActivityLogEntry['type'],
    payload: row.payload as Record<string, unknown>,
    seq: numReq(row.seq),
  };
}

export function userRowToDomain(row: PrismaUser): User {
  return {
    id: row.id,
    privyDid: row.privyDid,
    email: row.email,
    createdAt: numReq(row.createdAt),
  };
}

export function userWalletRowToDomain(row: PrismaUserWallet): UserWallet {
  return {
    id: row.id,
    userId: row.userId,
    privyWalletId: row.privyWalletId,
    walletAddress: row.walletAddress,
    isPrimary: row.isPrimary,
    createdAt: numReq(row.createdAt),
  };
}

export function tokenRowToDomain(row: PrismaToken): Token {
  return {
    id: row.id,
    chainId: row.chainId,
    chain: row.chain,
    address: row.address.toLowerCase(),
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    logoUri: row.logoUri,
    coingeckoId: row.coingeckoId,
  };
}

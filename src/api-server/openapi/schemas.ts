import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const RiskLimitsSchema = z.object({
  maxTradeUSD: z.number().nonnegative(),
  maxSlippageBps: z.number().int().nonnegative(),
}).passthrough();

const CONNECTED_AGENT_IDS_DESCRIPTION =
  'Symmetric links for agent-to-agent messaging: each pair is one mutual connection. On write, unknown ids, other users’ agents, self, and duplicates are ignored. Re-sending an existing link is a no-op. PATCH replaces this agent’s link set; omitted ids are removed for both peers.';
const CONNECTED_CHANNEL_IDS_DESCRIPTION =
  'Channel memberships for this agent. IDs refer to AXL channels owned by the same user.';
const TOOL_IDS_DESCRIPTION =
  'List of enabled tool IDs for this agent. IDs must exist in GET /tools. PATCH replaces this set when provided.';

export const AgentConfigSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  prompt: z.string(),
  dryRun: z.boolean(),
  dryRunSeedBalances: z.record(z.string()).optional(),
  allowedTokens: z.array(z.string()),
  toolIds: z.array(z.string()).openapi({ description: TOOL_IDS_DESCRIPTION }),
  connectedAgentIds: z.array(z.string()).openapi({ description: CONNECTED_AGENT_IDS_DESCRIPTION }),
  connectedChannelIds: z.array(z.string()).openapi({ description: CONNECTED_CHANNEL_IDS_DESCRIPTION }),
  riskLimits: RiskLimitsSchema,
  createdAt: z.number(),
  running: z.boolean().optional(),
  intervalMs: z.number().int().nonnegative().optional(),
  lastTickAt: z.number().nullable().optional(),
}).openapi('AgentConfig');

export const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  dryRun: z.boolean(),
  dryRunSeedBalances: z.record(z.string()).optional(),
  allowedTokens: z.array(z.string()).default([]),
  toolIds: z.array(z.string()).optional().openapi({ description: TOOL_IDS_DESCRIPTION }),
  connectedAgentIds: z.array(z.string()).default([]).openapi({ description: CONNECTED_AGENT_IDS_DESCRIPTION }),
  connectedChannelIds: z.array(z.string()).default([]).openapi({ description: CONNECTED_CHANNEL_IDS_DESCRIPTION }),
  riskLimits: RiskLimitsSchema,
  intervalMs: z.number().int().min(1000).optional(),
}).openapi('CreateAgentBody');

export const UpdateAgentBodySchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  allowedTokens: z.array(z.string()).optional(),
  toolIds: z.array(z.string()).optional().openapi({ description: TOOL_IDS_DESCRIPTION }),
  connectedAgentIds: z.array(z.string()).optional().openapi({ description: CONNECTED_AGENT_IDS_DESCRIPTION }),
  connectedChannelIds: z.array(z.string()).optional().openapi({ description: CONNECTED_CHANNEL_IDS_DESCRIPTION }),
  riskLimits: RiskLimitsSchema.optional(),
  intervalMs: z.number().int().min(1000).optional(),
}).openapi('UpdateAgentBody');

export const ManageAgentConnectionBodySchema = z.object({
  peerAgentId: z.string().min(1),
}).openapi('ManageAgentConnectionBody');

export const ManageAgentChannelBodySchema = z.object({
  channelId: z.string().min(1),
}).openapi('ManageAgentChannelBody');

export const AxlChannelSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1),
  createdAt: z.number(),
  memberAgentIds: z.array(z.string()),
}).openapi('AxlChannel');

export const CreateAxlChannelBodySchema = z.object({
  name: z.string().min(1),
}).openapi('CreateAxlChannelBody');

export const PostMessageBodySchema = z.object({
  content: z.string().min(1),
}).openapi('PostMessageBody');

export const ChatMessageViewSchema = z.object({
  tickId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    argumentsJson: z.string(),
  })).optional(),
  toolCallId: z.string().optional(),
  createdAt: z.number(),
}).openapi('ChatMessageView');

export const ActivityLogEntrySchema = z.object({
  agentId: z.string(),
  tickId: z.string(),
  seq: z.number().int(),
  timestamp: z.number(),
  type: z.enum(['user_message', 'tick_start', 'tick_end', 'tool_call', 'tool_result', 'llm_call', 'llm_response', 'memory_update', 'error']),
  payload: z.record(z.unknown()),
}).openapi('ActivityLogEntry');

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const PageOfActivitySchema = z.object({
  items: z.array(ActivityLogEntrySchema),
  nextCursor: z.string().nullable(),
}).openapi('PageOfActivity');

export const PageOfMessagesSchema = z.object({
  items: z.array(ChatMessageViewSchema),
  nextCursor: z.string().nullable(),
}).openapi('PageOfMessages');

export const PostMessageAcceptedSchema = z.object({
  position: z.number().int(),
}).openapi('PostMessageAccepted');

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
}).openapi('ErrorResponse');

export const UserSchema = z.object({
  id: z.string(),
  privyDid: z.string(),
  email: z.string().nullable(),
  createdAt: z.number(),
}).openapi('User');

export const UserWalletSchema = z.object({
  id: z.string(),
  walletAddress: z.string(),
  isPrimary: z.boolean(),
  createdAt: z.number(),
}).openapi('UserWallet');

export const UsersMeResponseSchema = z.object({
  user: UserSchema,
  wallets: z.array(UserWalletSchema),
}).openapi('UsersMeResponse');

export const TokenViewSchema = z.object({
  id: z.number().int(),
  chainId: z.number().int(),
  chain: z.string(),
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int(),
  logoUri: z.string().nullable(),
  coingeckoId: z.string().nullable(),
}).openapi('TokenView');

export const TokensListResponseSchema = z.object({
  tokens: z.array(TokenViewSchema),
  nextCursor: z.string().nullable(),
}).openapi('TokensListResponse');

export const AllowedTokensResponseSchema = z.object({
  tokens: z.array(TokenViewSchema),
}).openapi('AllowedTokensResponse');

export const UnknownTokensErrorSchema = z.object({
  error: z.literal('unknown_tokens'),
  unknownAddresses: z.array(z.string()),
}).openapi('UnknownTokensError');

export const UnknownToolIdsErrorSchema = z.object({
  error: z.literal('unknown_tool_ids'),
  unknownToolIds: z.array(z.string()),
}).openapi('UnknownToolIdsError');

export const ToolCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  callableName: z.string(),
  description: z.string(),
  category: z.string().optional(),
}).openapi('ToolCatalogItem');

export const ToolsListResponseSchema = z.object({
  tools: z.array(ToolCatalogItemSchema),
}).openapi('ToolsListResponse');

export const TreasuryDepositBodySchema = z.object({
  amount: z.string().min(1),
}).openapi('TreasuryDepositBody');

export const FakePurchaseBodySchema = z.object({
  amount: z.string().min(1).optional(),
}).openapi('FakePurchaseBody');

export const TreasuryDepositResponseSchema = z.object({
  txHash: z.string(),
  amount: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
}).openapi('TreasuryDepositResponse');

export const ZeroGPurchaseStatusSchema = z.enum([
  'pending',
  'bridging',
  'swapping',
  'sending',
  'topping_up',
  'completed',
  'failed',
]);

export const ZeroGPurchaseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userWalletAddress: z.string(),

  incomingTxHash: z.string(),
  incomingUsdcAmount: z.string(),

  serviceFeeUsdcAmount: z.string(),
  swapInputUsdcAmount: z.string(),

  bridgeTxHash: z.string().optional(),
  bridgeGasCostWei: z.string().optional(),

  swapTxHash: z.string().optional(),
  swapInputUsdceAmount: z.string().optional(),
  swapOutputW0gAmount: z.string().optional(),
  swapGasCostWei: z.string().optional(),

  unwrapTxHash: z.string().optional(),
  unwrapGasCostWei: z.string().optional(),
  unwrappedOgAmount: z.string().optional(),

  sendTxHash: z.string().optional(),
  sendGasCostWei: z.string().optional(),
  ogAmountSentToUser: z.string().optional(),

  ledgerTopUpTxHash: z.string().optional(),
  ledgerTopUpGasCostWei: z.string().optional(),

  status: ZeroGPurchaseStatusSchema,
  errorMessage: z.string().optional(),

  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi('ZeroGPurchase');

export const ZeroGPurchaseListResponseSchema = z.object({
  items: z.array(ZeroGPurchaseSchema),
}).openapi('ZeroGPurchaseListResponse');

export const ProviderBalanceSchema = z.object({
  address: z.string(),
  model: z.string(),
  serviceType: z.string(),
  balanceRaw: z.string(),
  balanceFormatted: z.string(),
}).openapi('ProviderBalance');

export const LedgerBalanceSchema = z.object({
  totalRaw: z.string(),
  totalFormatted: z.string(),
  availableRaw: z.string(),
  availableFormatted: z.string(),
  lockedRaw: z.string(),
  lockedFormatted: z.string(),
}).openapi('LedgerBalance');

export const TokenBalanceWithPriceSchema = z.object({
  chainId: z.number().int(),
  address: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
  balanceRaw: z.string(),
  balanceFormatted: z.string(),
  priceUsd: z.number(),
  valueUsd: z.number(),
}).openapi('TokenBalanceWithPrice');

export const OnChainOGBalanceSchema = z.object({
  raw: z.string(),
  formatted: z.string(),
  priceUsd: z.number(),
  valueUsd: z.number(),
}).openapi('OnChainOGBalance');

export const ZeroGBalancesResponseSchema = z.object({
  providers: z.array(ProviderBalanceSchema),
  ledger: LedgerBalanceSchema,
  onChainOG: OnChainOGBalanceSchema,
}).openapi('ZeroGBalancesResponse');

export const ChainBalanceSchema = z.object({
  chainId: z.number().int(),
  tokens: z.array(TokenBalanceWithPriceSchema),
  totalValueUsd: z.number(),
}).openapi('ChainBalance');

export const WalletBalancesResponseSchema = z.object({
  chains: z.object({
    unichain: ChainBalanceSchema,
  }),
  totalValueUsd: z.number(),
}).openapi('WalletBalancesResponse');

export const SweepTransferSchema = z.object({
  symbol: z.string(),
  chainId: z.number().int(),
  raw: z.string(),
  txHash: z.string().optional(),
  error: z.string().optional(),
}).openapi('SweepTransfer');

export const SweepWalletResultSchema = z.object({
  walletAddress: z.string(),
  privyWalletId: z.string(),
  transfers: z.array(SweepTransferSchema),
}).openapi('SweepWalletResult');

export const SweepResponseSchema = z.object({
  recipient: z.string(),
  walletCount: z.number().int(),
  results: z.array(SweepWalletResultSchema),
}).openapi('SweepResponse');

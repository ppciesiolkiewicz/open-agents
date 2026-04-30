import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const RiskLimitsSchema = z.object({
  maxTradeUSD: z.number().nonnegative(),
  maxSlippageBps: z.number().int().nonnegative(),
}).passthrough();

export const AgentConfigSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  prompt: z.string(),
  dryRun: z.boolean(),
  dryRunSeedBalances: z.record(z.string()).optional(),
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
  riskLimits: RiskLimitsSchema,
  intervalMs: z.number().int().min(1000).optional(),
}).openapi('CreateAgentBody');

export const UpdateAgentBodySchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  riskLimits: RiskLimitsSchema.optional(),
  intervalMs: z.number().int().min(1000).optional(),
}).openapi('UpdateAgentBody');

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

export const TreasuryDepositBodySchema = z.object({
  amount: z.string().min(1),
}).openapi('TreasuryDepositBody');

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
  tokens: z.array(TokenBalanceWithPriceSchema),
}).openapi('ZeroGBalancesResponse');

export const ZeroGProviderListingSchema = z.object({
  providerAddress: z.string(),
  serviceUrl: z.string(),
  model: z.string(),
  inputPricePerToken: z.string().optional(),
  outputPricePerToken: z.string().optional(),
  subAccountBalanceWei: z.string().optional(),
}).openapi('ZeroGProviderListing');

export const ZeroGProvidersListResponseSchema = z.object({
  providers: z.array(ZeroGProviderListingSchema),
}).openapi('ZeroGProvidersListResponse');

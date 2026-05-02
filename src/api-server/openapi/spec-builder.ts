import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  registry,
  AgentConfigSchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
  ManageAgentConnectionBodySchema,
  ManageAgentChannelBodySchema,
  AxlChannelSchema,
  CreateAxlChannelBodySchema,
  PostMessageBodySchema,
  PostMessageAcceptedSchema,
  PageOfActivitySchema,
  PageOfMessagesSchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  UserWalletSchema,
  UsersMeResponseSchema,
  TreasuryDepositBodySchema,
  TreasuryDepositResponseSchema,
  FakePurchaseBodySchema,
  ZeroGPurchaseSchema,
  ZeroGPurchaseListResponseSchema,
  ZeroGBalancesResponseSchema,
  WalletBalancesResponseSchema,
  TokenViewSchema,
  TokensListResponseSchema,
  AllowedTokensResponseSchema,
  UnknownTokensErrorSchema,
  UnknownToolIdsErrorSchema,
  ToolsListResponseSchema,
} from './schemas';

function registerPaths(): void {
  registry.registerPath({
    method: 'get',
    path: '/users/me',
    description: 'Returns the authenticated user (resolved from the Privy JWT) and their wallets.',
    responses: {
      200: { description: 'user + wallets', content: { 'application/json': { schema: UsersMeResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/users/me/wallets',
    description: 'Provisions the primary Privy server wallet for the authenticated user. Idempotent: returns the existing primary if one exists.',
    responses: {
      200: { description: 'existing primary wallet', content: { 'application/json': { schema: UserWalletSchema } } },
      201: { description: 'newly created primary wallet', content: { 'application/json': { schema: UserWalletSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
      502: { description: 'Privy wallet provisioning failed', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/users/me/treasury/purchases',
    description: 'Lists ZeroGPurchase rows for the authenticated user, most recent first. Optional `status` query is a comma-separated list (e.g. `?status=pending,swapping,sending,topping_up` for in-progress only). Use this to track the status of in-flight deposits.',
    request: {
      query: z.object({
        status: z.string().optional().openapi({ description: 'Comma-separated list of statuses to filter by. Allowed: pending, swapping, sending, topping_up, completed, failed.' }),
      }),
    },
    responses: {
      200: { description: 'list of purchases', content: { 'application/json': { schema: ZeroGPurchaseListResponseSchema } } },
      400: { description: 'invalid status value', content: { 'application/json': { schema: ErrorResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/users/me/treasury/purchases/{id}',
    description: 'Returns a single ZeroGPurchase by id. 404 if not found or owned by a different user.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'purchase', content: { 'application/json': { schema: ZeroGPurchaseSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/users/me/treasury/purchases/fake',
    description: 'Creates a fake ZeroGPurchase row in `pending` status for the authenticated user, returns it immediately, then asynchronously advances the row through `swapping` → `sending` → `topping_up` → `completed` with a 2-second delay between each transition. No on-chain actions occur. Useful for exercising client UIs that subscribe to purchase status. Optional `amount` body field controls the incoming USDC amount (default `1`).',
    request: { body: { content: { 'application/json': { schema: FakePurchaseBodySchema } } } },
    responses: {
      201: { description: 'fake purchase created', content: { 'application/json': { schema: ZeroGPurchaseSchema } } },
      400: { description: 'no primary wallet', content: { 'application/json': { schema: ErrorResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/users/me/treasury/deposit',
    description: 'Sends USDC from the authenticated user\'s primary Privy wallet on Unichain to the treasury wallet. The TreasuryFundsWatcher detects the transfer and triggers the swap → send → broker top-up pipeline asynchronously.',
    request: { body: { content: { 'application/json': { schema: TreasuryDepositBodySchema } } } },
    responses: {
      201: { description: 'transfer submitted', content: { 'application/json': { schema: TreasuryDepositResponseSchema } } },
      400: { description: 'no primary wallet', content: { 'application/json': { schema: ErrorResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/tokens',
    description: 'Catalog of supported tokens, paginated. Filter by chainId, symbol, or search (matches symbol or name, case-insensitive).',
    request: {
      query: z.object({
        chainId: z.coerce.number().int().optional(),
        symbol: z.string().optional(),
        search: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
    responses: {
      200: { description: 'page of tokens', content: { 'application/json': { schema: TokensListResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/tools',
    description: 'Returns the configured catalog of tools available for agent enablement.',
    responses: {
      200: { description: 'available tools', content: { 'application/json': { schema: ToolsListResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/users/me/zerog/balances',
    description: 'Get 0G balance across providers, ledger, and on-chain wallet',
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': { schema: ZeroGBalancesResponseSchema } },
      },
      400: {
        description: 'No wallet provisioned',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      401: {
        description: 'invalid or missing token',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      500: {
        description: 'Server error (broker unavailable, RPC timeout, etc.)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/users/me/wallet/balances',
    description: 'Get per-chain token balances with USD prices for the authenticated user',
    responses: {
      200: {
        description: 'Success',
        content: { 'application/json': { schema: WalletBalancesResponseSchema } },
      },
      400: {
        description: 'No wallet provisioned',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      401: {
        description: 'invalid or missing token',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
      500: {
        description: 'Server error (RPC timeout, Coingecko unavailable, etc.)',
        content: { 'application/json': { schema: ErrorResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents',
    responses: {
      200: { description: 'list of agents', content: { 'application/json': { schema: z.array(AgentConfigSchema) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/axl/channels',
    description: 'Lists AXL channels owned by the authenticated user.',
    responses: {
      200: { description: 'list of channels', content: { 'application/json': { schema: z.array(AxlChannelSchema) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/axl/channels',
    description: 'Creates a new AXL channel for the authenticated user.',
    request: { body: { content: { 'application/json': { schema: CreateAxlChannelBodySchema } } } },
    responses: {
      201: { description: 'created', content: { 'application/json': { schema: AxlChannelSchema } } },
      400: { description: 'invalid input', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/axl/channels/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'channel', content: { 'application/json': { schema: AxlChannelSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/axl/channels/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'deleted' },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents',
    request: { body: { content: { 'application/json': { schema: CreateAgentBodySchema } } } },
    responses: {
      201: { description: 'created', content: { 'application/json': { schema: AgentConfigSchema } } },
      400: { description: 'invalid input or unknown tokens/tool ids', content: { 'application/json': { schema: z.union([UnknownTokensErrorSchema, UnknownToolIdsErrorSchema]) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'agent', content: { 'application/json': { schema: AgentConfigSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/agents/{id}',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateAgentBodySchema } } },
    },
    responses: {
      200: { description: 'updated', content: { 'application/json': { schema: AgentConfigSchema } } },
      400: { description: 'invalid input or unknown tokens/tool ids', content: { 'application/json': { schema: z.union([UnknownTokensErrorSchema, UnknownToolIdsErrorSchema]) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/connections',
    description: 'Adds a symmetric peer connection for this agent. No-op when already connected, self, unknown, or cross-user.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: ManageAgentConnectionBodySchema } } },
    },
    responses: {
      200: { description: 'updated', content: { 'application/json': { schema: AgentConfigSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/agents/{id}/connections/{peerAgentId}',
    description: 'Removes a symmetric peer connection for this agent. No-op if the connection is absent.',
    request: { params: z.object({ id: z.string(), peerAgentId: z.string() }) },
    responses: {
      200: { description: 'updated', content: { 'application/json': { schema: AgentConfigSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/channels',
    description: 'Adds this agent to an AXL channel owned by the same user. No-op when membership already exists.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: ManageAgentChannelBodySchema } } },
    },
    responses: {
      200: { description: 'updated', content: { 'application/json': { schema: AgentConfigSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/agents/{id}/channels/{channelId}',
    description: 'Removes this agent from an AXL channel. No-op when membership is absent.',
    request: { params: z.object({ id: z.string(), channelId: z.string() }) },
    responses: {
      200: { description: 'updated', content: { 'application/json': { schema: AgentConfigSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}/allowed-tokens',
    description: 'Returns the resolved Token rows in the agent\'s allowlist.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'allowed tokens', content: { 'application/json': { schema: AllowedTokensResponseSchema } } },
      401: { description: 'invalid or missing token', content: { 'application/json': { schema: ErrorResponseSchema } } },
      404: { description: 'agent not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/agents/{id}',
    request: { params: z.object({ id: z.string() }) },
    responses: { 204: { description: 'deleted' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/start',
    description: 'Set running = true. Triggers scheduled ticks if intervalMs is set.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'started', content: { 'application/json': { schema: AgentConfigSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/stop',
    description: 'Set running = false. Stops scheduled ticks.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'stopped', content: { 'application/json': { schema: AgentConfigSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}/activity',
    request: {
      params: z.object({ id: z.string() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'activity page', content: { 'application/json': { schema: PageOfActivitySchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}/messages',
    request: {
      params: z.object({ id: z.string() }),
      query: PaginationQuerySchema,
    },
    responses: {
      200: { description: 'messages page', content: { 'application/json': { schema: PageOfMessagesSchema } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents/{id}/messages',
    description: 'Enqueues a chat task. Returns immediately with queue position. Subscribe to GET /agents/{id}/stream to receive events.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: PostMessageBodySchema } } },
    },
    responses: {
      202: { description: 'enqueued', content: { 'application/json': { schema: PostMessageAcceptedSchema } } },
      404: { description: 'not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/agents/{id}/stream',
    description: 'SSE: streams all activity-log appends + ephemeral events for this agent. Each `data:` line is `{ type: "append"|"ephemeral", entry|payload }`.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'SSE stream', content: { 'text/event-stream': { schema: z.string() } } },
    },
  });
}

let registered = false;

export function buildOpenApiDocument(): object {
  if (!registered) {
    registerPaths();
    registered = true;
  }
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Agent Loop API', version: '0.1.0' },
    servers: [{ url: '/' }],
  });
}

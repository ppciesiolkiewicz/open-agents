import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  registry,
  AgentConfigSchema,
  CreateAgentBodySchema,
  UpdateAgentBodySchema,
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
  ZeroGPurchaseSchema,
  ZeroGPurchaseListResponseSchema,
  TokenViewSchema,
  TokensListResponseSchema,
  AllowedTokensResponseSchema,
  UnknownTokensErrorSchema,
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
        status: z.string().optional().openapi({ description: 'Comma-separated list of statuses to filter by. Allowed: pending, bridging, swapping, sending, topping_up, completed, failed.' }),
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
    path: '/users/me/treasury/deposit',
    description: 'Sends USDC from the authenticated user\'s primary Privy wallet on Unichain to the treasury wallet. The TreasuryFundsWatcher detects the transfer and triggers the swap → bridge → broker top-up pipeline asynchronously.',
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
    path: '/agents',
    responses: {
      200: { description: 'list of agents', content: { 'application/json': { schema: z.array(AgentConfigSchema) } } },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/agents',
    request: { body: { content: { 'application/json': { schema: CreateAgentBodySchema } } } },
    responses: {
      201: { description: 'created', content: { 'application/json': { schema: AgentConfigSchema } } },
      400: { description: 'invalid input or unknown tokens in allowlist', content: { 'application/json': { schema: UnknownTokensErrorSchema } } },
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
      400: { description: 'invalid input or unknown tokens in allowlist', content: { 'application/json': { schema: UnknownTokensErrorSchema } } },
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

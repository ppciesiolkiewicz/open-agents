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
} from './schemas';

function registerPaths(): void {
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
      400: { description: 'invalid input', content: { 'application/json': { schema: ErrorResponseSchema } } },
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

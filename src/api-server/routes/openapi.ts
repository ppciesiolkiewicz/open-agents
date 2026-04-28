import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../openapi/spec-builder';

export function buildOpenApiSpecRouter(): Router {
  const r = Router();
  const doc = buildOpenApiDocument();
  r.get('/openapi.json', (_req, res) => res.json(doc));
  return r;
}

export function buildSwaggerUiRouter(): Router {
  const r = Router();
  const doc = buildOpenApiDocument();
  r.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
  r.get('/openapi.json', (_req, res) => res.json(doc));
  return r;
}

export function buildOpenApiRouter(): Router {
  const r = Router();
  const doc = buildOpenApiDocument();
  r.get('/openapi.json', (_req, res) => res.json(doc));
  r.use('/docs', swaggerUi.serve, swaggerUi.setup(doc));
  return r;
}

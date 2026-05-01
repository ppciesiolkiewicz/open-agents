import { Router } from 'express';
import { listAllToolCatalogItems } from '../../ai-tools/tool-catalog';

export function buildToolsRouter(): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json({ tools: listAllToolCatalogItems() });
  });

  return r;
}

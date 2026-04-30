import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../database/database';

interface Deps {
  db: Database;
}

const QuerySchema = z.object({
  chainId: z.coerce.number().int().optional(),
  symbol: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function buildTokensRouter(deps: Deps): Router {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const q = QuerySchema.parse(req.query);
      const page = await deps.db.tokens.list(q);
      res.json(page);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

import cors from 'cors';
import type { RequestHandler } from 'express';

export function buildCorsMiddleware(originsCsv: string | undefined): RequestHandler {
  if (!originsCsv || originsCsv.trim() === '*') {
    return cors({ origin: true, credentials: false });
  }
  const allow = originsCsv.split(',').map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: (origin, cb) => {
      if (!origin || allow.includes(origin)) return cb(null, true);
      cb(new Error(`origin ${origin} not allowed`));
    },
    credentials: false,
  });
}

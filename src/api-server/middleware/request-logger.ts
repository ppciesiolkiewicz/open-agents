import type { NextFunction, Request, RequestHandler, Response } from 'express';

const REDACTED_KEYS = new Set([
  'password',
  'secret',
  'token',
  'authorization',
  'privatekey',
  'private_key',
  'apikey',
  'api_key',
  'mnemonic',
  'seed',
]);

const MAX_BODY_LENGTH = 2000;

function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

function stringifyBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'object' && Object.keys(body as object).length === 0) return undefined;
  let s: string;
  try {
    s = JSON.stringify(redact(body));
  } catch {
    return '[unserializable]';
  }
  return s.length > MAX_BODY_LENGTH ? `${s.slice(0, MAX_BODY_LENGTH)}…[truncated]` : s;
}

export function buildRequestLoggerMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const { method, originalUrl } = req;
    const query = Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : undefined;
    const body = stringifyBody(req.body);

    res.on('finish', () => {
      const durMs = Date.now() - start;
      const did = req.user?.privyDid ?? '-';
      const parts = [
        `[api-server]`,
        `${method} ${originalUrl}`,
        `${res.statusCode}`,
        `${durMs}ms`,
        `user=${did}`,
      ];
      if (query) parts.push(`query=${query}`);
      if (body) parts.push(`body=${body}`);
      console.log(parts.join(' '));
    });

    next();
  };
}

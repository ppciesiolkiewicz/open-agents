import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ForbiddenError } from './auth';

export class NotFoundError extends Error {
  constructor(public readonly errorCode = 'agent_not_found') {
    super(errorCode);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends Error {
  constructor(public readonly errorCode: string, message?: string) {
    super(message ?? errorCode);
    this.name = 'BadRequestError';
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: err.issues });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.errorCode });
    return;
  }
  if (err instanceof ForbiddenError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.errorCode, message: err.message });
    return;
  }
  const e = err as Error;
  console.error('[api-server] unhandled error:', e);
  res.status(500).json({ error: 'internal_error', message: e.message });
}

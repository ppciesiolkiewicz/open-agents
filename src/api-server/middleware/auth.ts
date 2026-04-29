import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { User } from '../../database/types';
import type { UserRepository } from '../../database/repositories/user-repository';
import type { PrivyAuth } from '../auth/privy-auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ForbiddenError';
  }
}

export function buildAuthMiddleware(
  privyAuth: PrivyAuth,
  users: UserRepository,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const token = header.slice(7);
    let did: string;
    try {
      const verified = await privyAuth.verifyToken(token);
      did = verified.did;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    try {
      const email = await privyAuth.getEmail(did);
      const user = await users.findOrCreateByPrivyDid(did, { email });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

import type { NextFunction, Request, Response } from 'express';
import type { AgentConfig } from '../../database/types';

export interface ApiUser {
  id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: ApiUser;
    }
  }
}

const STUB_USER: ApiUser = { id: 'local-dev' };

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // v1 stub: any request gets a fixed user; JWT decode lands here later.
  req.user = STUB_USER;
  next();
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ForbiddenError';
  }
}

export function assertAgentOwnedBy(agent: AgentConfig, _user: ApiUser): void {
  // v1 noop. When AgentConfig gains userId, compare and throw ForbiddenError on mismatch.
  void agent;
}

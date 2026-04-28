import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AgentActivityLog } from '../database/agent-activity-log';
import type { AgentRunner } from '../agent-runner/agent-runner';
import type { TickQueue } from '../agent-runner/tick-queue';
import type { Database } from '../database/database';
import { authMiddleware } from './middleware/auth';
import { buildCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { buildAgentsRouter } from './routes/agents';
import { buildActivityRouter } from './routes/activity';
import { buildMessagesRouter } from './routes/messages';
import { buildStreamRouter } from './routes/stream';
import { buildOpenApiRouter } from './routes/openapi';

export interface ApiServerDeps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
  queue: TickQueue;
  port: number;
  corsOrigins?: string;
}

export class ApiServer {
  private readonly app: Express;
  private server: Server | null = null;

  constructor(private readonly deps: ApiServerDeps) {
    this.app = express();
    this.app.use(buildCorsMiddleware(deps.corsOrigins));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(authMiddleware);

    this.app.use('/', buildOpenApiRouter());
    this.app.use('/agents', buildAgentsRouter({ db: deps.db }));
    this.app.use('/agents/:id/activity', buildActivityRouter({ db: deps.db, activityLog: deps.activityLog }));
    this.app.use('/agents/:id/messages', buildMessagesRouter({ db: deps.db, activityLog: deps.activityLog, runner: deps.runner, queue: deps.queue }));
    this.app.use('/agents/:id/stream', buildStreamRouter({ db: deps.db, activityLog: deps.activityLog }));

    this.app.use(errorHandler);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.deps.port, () => {
        console.log(`[api-server] listening on http://localhost:${this.deps.port} (docs: /docs)`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getApp(): Express {
    return this.app;
  }
}

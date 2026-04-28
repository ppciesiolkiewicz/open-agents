import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
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
import {
  buildOpenApiRouter,
  buildOpenApiSpecRouter,
  buildSwaggerUiRouter,
} from './routes/openapi';

export interface ApiServerDeps {
  db: Database;
  activityLog: AgentActivityLog;
  runner: AgentRunner;
  queue: TickQueue;
  port: number;
  docsPort?: number;
  corsOrigins?: string;
}

export class ApiServer {
  private readonly app: Express;
  private readonly docsApp: Express | null;
  private server: Server | null = null;
  private docsServer: Server | null = null;

  constructor(private readonly deps: ApiServerDeps) {
    this.app = express();
    this.app.use(buildCorsMiddleware(deps.corsOrigins));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(authMiddleware);

    const docsOnSeparatePort = deps.docsPort && deps.docsPort !== deps.port;

    this.app.use('/', docsOnSeparatePort ? buildOpenApiSpecRouter() : buildOpenApiRouter());
    this.app.use('/agents', buildAgentsRouter({ db: deps.db }));
    this.app.use('/agents/:id/activity', buildActivityRouter({ db: deps.db, activityLog: deps.activityLog }));
    this.app.use('/agents/:id/messages', buildMessagesRouter({ db: deps.db, activityLog: deps.activityLog, runner: deps.runner, queue: deps.queue }));
    this.app.use('/agents/:id/stream', buildStreamRouter({ db: deps.db, activityLog: deps.activityLog }));

    this.app.use(errorHandler);

    if (docsOnSeparatePort) {
      this.docsApp = express();
      this.docsApp.use(buildCorsMiddleware(deps.corsOrigins));
      this.docsApp.use(buildSwaggerUiRouter());
    } else {
      this.docsApp = null;
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(this.deps.port, () => {
        const docsHint = this.docsApp ? '' : ' (docs: /docs)';
        console.log(`[api-server] listening on http://localhost:${this.deps.port}${docsHint}`);
        resolve();
      });
    });

    if (this.docsApp && this.deps.docsPort) {
      const port = this.deps.docsPort;
      await new Promise<void>((resolve) => {
        this.docsServer = this.docsApp!.listen(port, () => {
          console.log(`[api-server] swagger UI on http://localhost:${port}/docs`);
          resolve();
        });
      });
    }
  }

  async stop(): Promise<void> {
    const closeOne = (s: Server | null) =>
      new Promise<void>((resolve, reject) => {
        if (!s) return resolve();
        s.close((err) => (err ? reject(err) : resolve()));
      });
    await Promise.all([closeOne(this.server), closeOne(this.docsServer)]);
  }

  getApp(): Express {
    return this.app;
  }
}

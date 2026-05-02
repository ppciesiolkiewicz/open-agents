import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { PrivyClient } from '@privy-io/server-auth';
import type { AgentActivityLog } from '../database/agent-activity-log';
import type { TickQueue } from '../agent-runner/tick-queue';
import type { Database } from '../database/database';
import type { PrivyAuth } from './auth/privy-auth';
import type { WalletProvisioner } from '../wallet/privy/wallet-provisioner';
import type { BalanceService } from '../balance/balance-service';
import type { CoingeckoService } from '../providers/coingecko/coingecko-service';
import type { ZeroGBrokerService } from '../ai/zerog-broker/zerog-broker-service';
import type { Env } from '../config/env';
import { buildAuthMiddleware } from './middleware/auth';
import { buildCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { buildRequestLoggerMiddleware } from './middleware/request-logger';
import { buildAgentsRouter } from './routes/agents';
import { buildActivityRouter } from './routes/activity';
import { buildMessagesRouter } from './routes/messages';
import { buildStreamRouter } from './routes/stream';
import { buildUsersRouter } from './routes/users';
import { buildOpenApiRouter } from './routes/openapi';
import { buildTreasuryRouter } from './routes/treasury';
import { buildZeroGRouter } from './routes/zerog';
import { buildWalletRouter } from './routes/wallet';
import { buildTokensRouter } from './routes/tokens';
import { buildToolsRouter } from './routes/tools';
import { buildAxlChannelsRouter } from './routes/axl-channels';

export interface ApiServerDeps {
  db: Database;
  activityLog: AgentActivityLog;
  queue: TickQueue;
  privyAuth: PrivyAuth;
  walletProvisioner: WalletProvisioner;
  balanceService: BalanceService;
  coingecko: CoingeckoService;
  brokerService: ZeroGBrokerService;
  privy: PrivyClient;
  env: Env;
  treasuryAddress: `0x${string}`;
  port: number;
  localAxlPeerId: string;
  corsOrigins?: string;
}

export class ApiServer {
  private readonly app: Express;
  private server: Server | null = null;

  constructor(private readonly deps: ApiServerDeps) {
    this.app = express();
    this.app.use(buildCorsMiddleware(deps.corsOrigins));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(buildRequestLoggerMiddleware());

    // OpenAPI docs are public.
    this.app.use('/', buildOpenApiRouter());

    // All other routes require Privy auth.
    this.app.use(buildAuthMiddleware(deps.privyAuth, deps.db.users));

    this.app.use('/users', buildUsersRouter({ db: deps.db, walletProvisioner: deps.walletProvisioner, balanceService: deps.balanceService }));
    this.app.use('/users/me/treasury', buildTreasuryRouter({ db: deps.db, privy: deps.privy, env: deps.env, treasuryAddress: deps.treasuryAddress }));
    this.app.use('/users/me/zerog', buildZeroGRouter({
      db: deps.db,
      balanceService: deps.balanceService,
      brokerService: deps.brokerService,
    }));
    this.app.use('/users/me/wallet', buildWalletRouter({
      db: deps.db,
      balanceService: deps.balanceService,
      coingecko: deps.coingecko,
    }));
    this.app.use('/tokens', buildTokensRouter({ db: deps.db }));
    this.app.use('/tools', buildToolsRouter());
    this.app.use('/axl/channels', buildAxlChannelsRouter({ db: deps.db }));
    this.app.use('/agents', buildAgentsRouter({ db: deps.db, localAxlPeerId: deps.localAxlPeerId }));
    this.app.use('/agents/:id/activity', buildActivityRouter({ db: deps.db, activityLog: deps.activityLog }));
    this.app.use('/agents/:id/messages', buildMessagesRouter({ db: deps.db, activityLog: deps.activityLog, queue: deps.queue }));
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

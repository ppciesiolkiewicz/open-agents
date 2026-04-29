import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { ApiServer } from './api-server/server';
import { PrivyClient } from '@privy-io/server-auth';
import { PrivyAuth } from './api-server/auth/privy-auth';
import { WalletProvisioner } from './wallet/privy/wallet-provisioner';
import { WORKER } from './constants';
import { IntervalScheduler } from './agent-worker/interval-scheduler';
import { AgentOrchestrator } from './agent-worker/agent-orchestrator';
import { TickDispatcher } from './agent-worker/tick-dispatcher';
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from './database/prisma-database/prisma-database';
import { AgentActivityLog } from './database/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';
import type { LLMClient } from './agent-runner/llm-client';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker } from './ai/zerog-broker/zerog-broker-factory';
import { silenceZeroGSdkNoise } from './ai/zerog-broker/silence-sdk-noise';
import { ZeroGLLMClient } from './ai/chat-model/zerog-llm-client';
import { ToolRegistry } from './ai-tools/tool-registry';
import { InMemoryTickQueue } from './agent-runner/tick-queue';
import { CoingeckoService } from './providers/coingecko/coingecko-service';
import { CoinMarketCapService } from './providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from './providers/serper/serper-service';
import { FirecrawlService } from './providers/firecrawl/firecrawl-service';
import { UniswapService } from './uniswap/uniswap-service';

async function buildLLM(env: Env): Promise<LLMClient> {
  const store = new ZeroGBootstrapStore(env.DB_DIR);
  const state = await store.load();
  if (!state) {
    console.log('[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.');
    return new StubLLMClient();
  }

  if (state.network !== env.ZEROG_NETWORK) {
    console.warn(
      `[bootstrap] WARNING: zerog-bootstrap.json was funded on '${state.network}' but env says '${env.ZEROG_NETWORK}'; using the file's network. Delete db/zerog-bootstrap.json and re-run \`npm run zerog-bootstrap\` to switch.`,
    );
  }

  const { broker } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: state.network,
  });
  silenceZeroGSdkNoise();
  console.log(`[bootstrap] 0G LLM ready — network=${state.network} provider=${state.providerAddress} model=${state.model}`);
  return new ZeroGLLMClient({
    broker,
    providerAddress: state.providerAddress,
    serviceUrl: state.serviceUrl,
    model: state.model,
  });
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error('[bootstrap] env validation failed:', (err as Error).message);
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const db = new PrismaDatabase(prisma);
  const activityLog = new AgentActivityLog(db.activityLog);
  const walletFactory = new WalletFactory(env, db.transactions);
  const uniswap = new UniswapService(env, db);
  const llm = await buildLLM(env);
  const toolRegistry = new ToolRegistry({
    coingecko: new CoingeckoService({ apiKey: env.COINGECKO_API_KEY }),
    coinmarketcap: new CoinMarketCapService({ apiKey: env.COINMARKETCAP_API_KEY }),
    serper: new SerperService({ apiKey: env.SERPER_API_KEY }),
    firecrawl: new FirecrawlService({ apiKey: env.FIRECRAWL_API_KEY }),
    db,
    uniswap,
  });
  const runner = new AgentRunner(db, activityLog, walletFactory, llm, toolRegistry);

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized (Postgres at ${env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')})`);
  console.log(`[bootstrap] wallet factory initialized`);
  console.log(`[bootstrap] tool registry initialized (${toolRegistry.build().length} tools)`);
  console.log(`[bootstrap] agent runner initialized (LLM: ${llm.modelName()})`);

  let privyAuth: PrivyAuth | null = null;
  let walletProvisioner: WalletProvisioner | null = null;

  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    console.error('[bootstrap] PRIVY_APP_ID + PRIVY_APP_SECRET are required for the server');
    process.exit(1);
  }
  const privy = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  privyAuth = new PrivyAuth(privy);
  walletProvisioner = new WalletProvisioner(privy, db.userWallets);
  console.log('[bootstrap] Privy auth + wallet provisioner initialized');

  const runLooper = true;
  const runServer = true;

  const queue = new InMemoryTickQueue({
    notify: (agentId, payload) => activityLog.emitEphemeral(agentId, payload),
  });

  let scheduler: IntervalScheduler | null = null;
  let dispatcher: TickDispatcher | null = null;
  if (runLooper) {
    const orchestrator = new AgentOrchestrator(db, queue);
    dispatcher = new TickDispatcher({ db, runner, activityLog, queue });
    dispatcher.start();
    scheduler = new IntervalScheduler({
      tickIntervalMs: WORKER.tickIntervalMs,
      onTick: async () => {
        const agents = await db.agents.list();
        console.log(
          `[worker] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
        );
        await orchestrator.tick();
      },
    });
    scheduler.start();
    console.log(`[bootstrap] scheduler started, ticking every ${WORKER.tickIntervalMs}ms`);
  }

  let api: ApiServer | null = null;
  if (runServer) {
    api = new ApiServer({
      db,
      activityLog,
      queue,
      privyAuth: privyAuth!,
      walletProvisioner: walletProvisioner!,
      port: env.PORT,
      ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
    });
    await api.start();
  }

  const shutdown = async (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping`);
    if (scheduler) scheduler.stop();
    if (dispatcher) await dispatcher.stop().catch(() => {});
    if (api) await api.stop().catch(() => {});
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});

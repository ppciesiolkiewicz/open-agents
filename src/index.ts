import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { ApiServer } from './api-server/server';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { AgentOrchestrator } from './agent-looper/agent-orchestrator';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';
import type { LLMClient } from './agent-runner/llm-client';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker } from './ai/zerog-broker/zerog-broker-factory';
import { silenceZeroGSdkNoise } from './ai/zerog-broker/silence-sdk-noise';
import { ZeroGLLMClient } from './ai/chat-model/zerog-llm-client';
import { ToolRegistry } from './ai-tools/tool-registry';
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

  const db = new FileDatabase(env.DB_DIR);
  const activityLog = new AgentActivityLog(new FileActivityLogStore(env.DB_DIR));
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
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}, MODE=${env.MODE}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);
  console.log(`[bootstrap] wallet factory initialized`);
  console.log(`[bootstrap] tool registry initialized (${toolRegistry.build().length} tools)`);
  console.log(`[bootstrap] agent runner initialized (LLM: ${llm.modelName()})`);

  const runLooper = env.MODE === 'looper' || env.MODE === 'both';
  const runServer = env.MODE === 'server' || env.MODE === 'both';

  let looper: Looper | null = null;
  if (runLooper) {
    const orchestrator = new AgentOrchestrator(db, runner);
    looper = new Looper({
      tickIntervalMs: LOOPER.tickIntervalMs,
      onTick: async () => {
        const agents = await db.agents.list();
        console.log(
          `[looper] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
        );
        await orchestrator.tick();
      },
    });
    looper.start();
    console.log(`[bootstrap] looper started, ticking every ${LOOPER.tickIntervalMs}ms`);
  }

  let api: ApiServer | null = null;
  if (runServer) {
    api = new ApiServer({
      db,
      activityLog,
      runner,
      port: env.PORT,
      ...(env.DOCS_PORT !== undefined ? { docsPort: env.DOCS_PORT } : {}),
      ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
    });
    await api.start();
  }

  const shutdown = async (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping`);
    if (looper) looper.stop();
    if (api) await api.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});

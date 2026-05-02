import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { WORKER, ZEROG_NETWORKS } from './constants';
import { IntervalScheduler } from './agent-worker/interval-scheduler';
import { AgentOrchestrator } from './agent-worker/agent-orchestrator';
import { TickDispatcher } from './agent-worker/tick-dispatcher';
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from './database/prisma-database/prisma-database';
import { AgentActivityLog } from './database/agent-activity-log';
import { RedisActivityBus } from './redis/redis-activity-bus';
import { RedisTickQueue } from './agent-runner/redis-tick-queue';
import { RedisClient } from './redis/redis-client';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { LLMClientFactory } from './ai/chat-model/llm-client-factory';
import { ZeroGBootstrapStore } from './ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGProvider } from './ai/zerog-broker/zerog-broker-factory';
import { silenceZeroGSdkNoise } from './ai/zerog-broker/silence-sdk-noise';
import { ToolRegistry } from './ai-tools/tool-registry';
import { CoingeckoService } from './providers/coingecko/coingecko-service';
import { CoinMarketCapService } from './providers/coinmarketcap/coinmarketcap-service';
import { SerperService } from './providers/serper/serper-service';
import { FirecrawlService } from './providers/firecrawl/firecrawl-service';
import { UniswapService } from './uniswap/uniswap-service';
import { PrivyClient } from '@privy-io/server-auth';
import { TreasuryWallet } from './treasury/treasury-wallet';
import { JaineSwapService } from './treasury/jaine-swap-service';
import { TreasuryFundsWatcher } from './treasury/treasury-funds-watcher';
import { TreasuryService } from './treasury/treasury-service';
import { AxlClient } from './axl/axl-client';
import { AxlPoller } from './axl/axl-poller';
import { createPublicClient, http, type PublicClient } from 'viem';
import { unichain } from 'viem/chains';

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

  const busPublisher = RedisClient.build(env.REDIS_URL);
  const busSubscriber = RedisClient.build(env.REDIS_URL);
  const activityBus = new RedisActivityBus({ publisher: busPublisher, subscriber: busSubscriber });
  const activityLog = new AgentActivityLog(db.activityLog, activityBus);

  const queueProducer = RedisClient.build(env.REDIS_URL);
  const queueSubscriber = RedisClient.build(env.REDIS_URL);
  const queue = new RedisTickQueue({ producer: queueProducer, subscriber: queueSubscriber });

  const axlClient = new AxlClient(env.AXL_URL);
  let localAxlPeerId = '';
  try {
    const topology = await axlClient.getTopology();
    localAxlPeerId = topology.ourPeerId;
    console.log(`[bootstrap] AXL node ready — peer=${localAxlPeerId}`);
    await db.agents.stampAxlPeerId(localAxlPeerId);
  } catch (err) {
    console.warn(`[bootstrap] AXL node not reachable at ${env.AXL_URL} — messaging tools will fail until node is available:`, err);
  }
  const axlPoller = new AxlPoller(axlClient, queue);

  const bootstrapStore = new ZeroGBootstrapStore(env.DB_DIR);
  const bootstrapState = await bootstrapStore.load();
  if (bootstrapState && bootstrapState.network !== env.ZEROG_NETWORK) {
    console.warn(
      `[bootstrap] WARNING: zerog-bootstrap.json was funded on '${bootstrapState.network}' but env says '${env.ZEROG_NETWORK}'; using the file's network.`,
    );
  }
  if (!bootstrapState) {
    console.log('[bootstrap] no zerog-bootstrap.json; using StubLLMClient. Run `npm run zerog-bootstrap` to fund a 0G provider.');
  } else {
    silenceZeroGSdkNoise();
    console.log(`[bootstrap] 0G LLM ready — network=${bootstrapState.network} provider=${bootstrapState.providerAddress} model=${bootstrapState.model}`);
  }

  const zerogNetwork = bootstrapState?.network ?? env.ZEROG_NETWORK;
  const zerogProvider = buildZeroGProvider(zerogNetwork);
  const privyClient = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  const walletFactory = new WalletFactory({
    env,
    walletMode: env.WALLET_MODE,
    transactions: db.transactions,
    userWallets: db.userWallets,
    privy: env.WALLET_MODE === 'pk' ? null : privyClient,
    publicClient: createPublicClient({ chain: unichain, transport: http(env.UNICHAIN_RPC_URL) }) as PublicClient,
    zerogProvider,
    zerogChainId: ZEROG_NETWORKS[zerogNetwork].chainId,
  });
  const uniswap = new UniswapService(env, db);
  const llmFactory = new LLMClientFactory(walletFactory, bootstrapState);
  const coingecko = new CoingeckoService({ apiKey: env.COINGECKO_API_KEY });
  const toolRegistry = new ToolRegistry({
    coingecko,
    coinmarketcap: new CoinMarketCapService({ apiKey: env.COINMARKETCAP_API_KEY }),
    serper: new SerperService({ apiKey: env.SERPER_API_KEY }),
    firecrawl: new FirecrawlService({ apiKey: env.FIRECRAWL_API_KEY }),
    db,
    uniswap,
    env,
    axlClient,
    localAxlPeerId,
  });
  const runner = new AgentRunner(db, activityLog, walletFactory, llmFactory, toolRegistry);

  console.log(`[bootstrap] worker — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`);
  console.log(`[bootstrap] postgres at ${env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bootstrap] redis at ${env.REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bootstrap] tools=${toolRegistry.build().length} llm=${llmFactory.modelName()} walletMode=${env.WALLET_MODE}`);

  const orchestrator = new AgentOrchestrator(db, queue);
  const dispatcher = new TickDispatcher({ db, runner, activityLog, queue });
  dispatcher.start();
  axlPoller.start();
  console.log('[bootstrap] AXL poller started');

  const treasuryWallet = new TreasuryWallet(env);
  const jaineSwap = new JaineSwapService(treasuryWallet);
  const treasuryWatcherRedis = RedisClient.build(env.REDIS_URL);
  const treasuryServiceRedis = RedisClient.build(env.REDIS_URL);
  const treasuryWatcher = new TreasuryFundsWatcher(env, treasuryWallet, treasuryWatcherRedis);
  const treasuryService = new TreasuryService(
    env,
    db,
    treasuryServiceRedis,
    treasuryWallet,
    jaineSwap,
    privyClient,
  );
  treasuryWatcher.start();
  treasuryService.start();

  const scheduler = new IntervalScheduler({
    tickIntervalMs: WORKER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(`[worker] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`);
      await orchestrator.tick();
    },
  });
  scheduler.start();
  console.log(`[bootstrap] scheduler started, ticking every ${WORKER.tickIntervalMs}ms`);

  const shutdown = async (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping`);
    scheduler.stop();
    axlPoller.stop();
    await dispatcher.stop().catch(() => {});
    treasuryWatcher.stop();
    await treasuryService.stop();
    await treasuryWatcherRedis.quit().catch(() => {});
    await treasuryServiceRedis.quit().catch(() => {});
    await activityBus.close().catch(() => {});
    await queueProducer.quit().catch(() => {});
    await queueSubscriber.quit().catch(() => {});
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});

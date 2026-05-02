import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { ApiServer } from './api-server/server';
import { PrivyClient } from '@privy-io/server-auth';
import { PrivyAuth } from './api-server/auth/privy-auth';
import { WalletProvisioner } from './wallet/privy/wallet-provisioner';
import { PrismaClient } from '@prisma/client';
import { PrismaDatabase } from './database/prisma-database/prisma-database';
import { AgentActivityLog } from './database/agent-activity-log';
import { RedisActivityBus } from './redis/redis-activity-bus';
import { RedisTickQueue } from './agent-runner/redis-tick-queue';
import { RedisClient } from './redis/redis-client';
import { BalanceService } from './balance/balance-service';
import { CoingeckoService } from './providers/coingecko/coingecko-service';
import { privateKeyToAccount } from 'viem/accounts';
import { buildZeroGBroker, buildEnvPkZeroGSigner } from './ai/zerog-broker/zerog-broker-factory';
import { ZeroGBrokerService } from './ai/zerog-broker/zerog-broker-service';
import { AxlClient } from './axl/axl-client';

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
  // server only enqueues — reuse queueProducer as subscriber to avoid an idle connection
  const queue = new RedisTickQueue({ producer: queueProducer, subscriber: queueProducer });

  const privy = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  const privyAuth = new PrivyAuth(privy);
  const walletProvisioner = new WalletProvisioner(privy, db.userWallets);
  const coingecko = new CoingeckoService({ apiKey: env.COINGECKO_API_KEY });
  const balanceService = new BalanceService(env, coingecko);

  const signer = buildEnvPkZeroGSigner(env.WALLET_PRIVATE_KEY, env.ZEROG_NETWORK);
  const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: env.ZEROG_NETWORK });
  const brokerService = new ZeroGBrokerService(broker);

  const treasuryAddress = privateKeyToAccount(env.TREASURY_WALLET_PRIVATE_KEY as `0x${string}`).address;

  const { ourPeerId: localAxlPeerId } = await new AxlClient(env.AXL_URL).getTopology();
  console.log(`[bootstrap] AXL node ready — peer=${localAxlPeerId}`);

  const api = new ApiServer({
    db,
    activityLog,
    queue,
    privyAuth,
    walletProvisioner,
    balanceService,
    coingecko,
    brokerService,
    privy,
    env,
    treasuryAddress,
    port: env.PORT,
    localAxlPeerId,
    ...(env.API_CORS_ORIGINS ? { corsOrigins: env.API_CORS_ORIGINS } : {}),
  });

  console.log(`[bootstrap] server — postgres at ${env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bootstrap] server — redis at ${env.REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  await api.start();

  const shutdown = async (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping`);
    await api.stop().catch(() => {});
    await activityBus.close().catch(() => {});
    await queueProducer.quit().catch(() => {});
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

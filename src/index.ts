import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { AgentOrchestrator } from './agent-looper/agent-orchestrator';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';
import { WalletFactory } from './wallet/factory/wallet-factory';
import { AgentRunner } from './agent-runner/agent-runner';
import { StubLLMClient } from './agent-runner/stub-llm-client';

function main(): void {
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
  const llm = new StubLLMClient();   // slice 5 will replace with the 0G-backed client
  const runner = new AgentRunner(db, activityLog, walletFactory, llm);
  const orchestrator = new AgentOrchestrator(db, runner);

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);
  console.log(`[bootstrap] wallet factory initialized`);
  console.log(`[bootstrap] agent runner initialized (LLM: ${llm.modelName()})`);

  const looper = new Looper({
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

  const shutdown = (signal: string) => {
    console.log(`[bootstrap] received ${signal}, stopping looper`);
    looper.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();

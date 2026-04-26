import 'dotenv/config';
import { loadEnv, type Env } from './config/env';
import { LOOPER } from './constants';
import { Looper } from './agent-looper/looper';
import { FileDatabase } from './database/file-database/file-database';
import { FileActivityLogStore } from './agent-activity-log/file-activity-log-store';
import { AgentActivityLog } from './agent-activity-log/agent-activity-log';

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
  void activityLog;  // wired for slice 4; not used this slice

  console.log(
    `[bootstrap] env loaded — ZEROG_NETWORK=${env.ZEROG_NETWORK}, DB_DIR=${env.DB_DIR}`,
  );
  console.log(`[bootstrap] database + activity log initialized at ${env.DB_DIR}`);

  const looper = new Looper({
    tickIntervalMs: LOOPER.tickIntervalMs,
    onTick: async () => {
      const agents = await db.agents.list();
      console.log(
        `[looper] tick @ ${new Date().toISOString()} — ${agents.length} agent(s) loaded`,
      );
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

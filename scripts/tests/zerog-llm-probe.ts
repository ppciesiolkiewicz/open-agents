import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { confirmContinue } from '../../src/test-lib/interactive-prompt';
import { ZeroGBootstrapStore } from '../../src/ai/zerog-broker/zerog-bootstrap-store';
import { buildZeroGBroker, buildEnvPkZeroGSigner } from '../../src/ai/zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from '../../src/ai/chat-model/zerog-llm-client';

const dbDir = process.env.DB_DIR ?? './db';

async function main(): Promise<void> {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('[llm-probe] WALLET_PRIVATE_KEY missing or not 0x-prefixed 32-byte hex.');
    process.exit(1);
  }
  const bootstrapPath = join(dbDir, 'zerog-bootstrap.json');
  if (!existsSync(bootstrapPath)) {
    console.error(`[llm-probe] ${bootstrapPath} not found. Run \`npm run zerog-bootstrap\` first.`);
    process.exit(1);
  }

  const store = new ZeroGBootstrapStore(dbDir);
  const state = await store.load();
  if (!state) {
    console.error('[llm-probe] bootstrap store returned null despite file existing.');
    process.exit(1);
  }

  const promptText = `Send one trivial inference request to provider ${state.providerAddress} (model: ${state.model}). This will spend a tiny amount of 0G from your sub-account. Continue?`;
  const ok = await confirmContinue(promptText);
  if (!ok) {
    console.log('[llm-probe] skipped by user.');
    return;
  }

  console.log(`[llm-probe] connecting to 0G ${state.network}…`);
  const signer = buildEnvPkZeroGSigner(key, state.network);
  const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: state.network });
  const client = new ZeroGLLMClient({
    broker,
    providerAddress: state.providerAddress,
    serviceUrl: state.serviceUrl,
    model: state.model,
  });

  console.log(`[llm-probe] sending prompt…`);
  const response = await client.invoke('Reply with the single word OK and nothing else.');
  console.log(`[llm-probe] model: ${client.modelName()}`);
  console.log(`[llm-probe] response: ${response.content}`);
  console.log(`[llm-probe] tokenCount: ${response.tokenCount ?? 'n/a'}`);
}

main().catch((err) => {
  console.error('[llm-probe] fatal:', err);
  process.exit(1);
});

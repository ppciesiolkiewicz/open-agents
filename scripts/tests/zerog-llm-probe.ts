import 'dotenv/config';
import { confirmContinue } from '../../src/test-lib/interactive-prompt';
import { loadEnv } from '../../src/config/env';
import { ZeroGRuntimeConfigLoader } from '../../src/ai/zerog-broker/zerog-runtime-config';
import { buildZeroGBroker, buildEnvPkZeroGSigner } from '../../src/ai/zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from '../../src/ai/chat-model/zerog-llm-client';

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = ZeroGRuntimeConfigLoader.fromEnv(env);
  if (!cfg) {
    console.error('[llm-probe] ZEROG_PROVIDER_ADDRESS / ZEROG_SERVICE_URL / ZEROG_MODEL not set in .env. Run `npm run zerog-bootstrap` first.');
    process.exit(1);
  }

  const promptText = `Send one trivial inference request to provider ${cfg.providerAddress} (model: ${cfg.model}). This will spend a tiny amount of 0G from your sub-account. Continue?`;
  const ok = await confirmContinue(promptText);
  if (!ok) {
    console.log('[llm-probe] skipped by user.');
    return;
  }

  console.log(`[llm-probe] connecting to 0G ${cfg.network}…`);
  const signer = buildEnvPkZeroGSigner(env.WALLET_PRIVATE_KEY, cfg.network);
  const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: cfg.network });
  const client = new ZeroGLLMClient({
    broker,
    providerAddress: cfg.providerAddress,
    serviceUrl: cfg.serviceUrl,
    model: cfg.model,
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

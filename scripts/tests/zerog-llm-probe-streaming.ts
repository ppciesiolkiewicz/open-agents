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
    console.error('[llm-probe-streaming] ZEROG_PROVIDER_ADDRESS / ZEROG_SERVICE_URL / ZEROG_MODEL not set in .env. Run `npm run zerog-bootstrap` first.');
    process.exit(1);
  }

  const promptText = `Send one streaming inference request to provider ${cfg.providerAddress} (model: ${cfg.model}). This will spend a tiny amount of 0G from your sub-account. Continue?`;
  const ok = await confirmContinue(promptText);
  if (!ok) {
    console.log('[llm-probe-streaming] skipped by user.');
    return;
  }

  console.log(`[llm-probe-streaming] connecting to 0G ${cfg.network}…`);
  const signer = buildEnvPkZeroGSigner(env.WALLET_PRIVATE_KEY, cfg.network);
  const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: cfg.network });
  const client = new ZeroGLLMClient({
    broker,
    providerAddress: cfg.providerAddress,
    serviceUrl: cfg.serviceUrl,
    model: cfg.model,
  });

  console.log(`[llm-probe-streaming] sending streaming prompt…`);
  const tokens: string[] = [];
  const result = await client.invokeWithTools(
    [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: "Say 'hi' in one word." },
    ],
    [],
    {
      onToken: (text) => {
        tokens.push(text);
        process.stdout.write(text);
      },
    },
  );
  process.stdout.write('\n');

  if (tokens.length > 0 && result.content !== tokens.join('')) {
    console.error('[llm-probe-streaming] FAIL: joined tokens do not match final content.');
    console.error(`  tokens joined : ${JSON.stringify(tokens.join(''))}`);
    console.error(`  result.content: ${JSON.stringify(result.content)}`);
    process.exit(1);
  }

  console.log(`[llm-probe-streaming] model       : ${client.modelName()}`);
  console.log(`[llm-probe-streaming] token count : ${tokens.length}`);
  console.log(`[llm-probe-streaming] total chars : ${(result.content ?? '').length}`);
  console.log(`[llm-probe-streaming] content     : ${result.content}`);
}

main().catch((err) => {
  console.error('[llm-probe-streaming] fatal:', err);
  process.exit(1);
});

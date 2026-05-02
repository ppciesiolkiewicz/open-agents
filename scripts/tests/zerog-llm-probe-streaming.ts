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
    console.error('[llm-probe-streaming] WALLET_PRIVATE_KEY missing or not 0x-prefixed 32-byte hex.');
    process.exit(1);
  }
  const bootstrapPath = join(dbDir, 'zerog-bootstrap.json');
  if (!existsSync(bootstrapPath)) {
    console.error(`[llm-probe-streaming] ${bootstrapPath} not found. Run \`npm run zerog-bootstrap\` first.`);
    process.exit(1);
  }

  const store = new ZeroGBootstrapStore(dbDir);
  const state = await store.load();
  if (!state) {
    console.error('[llm-probe-streaming] bootstrap store returned null despite file existing.');
    process.exit(1);
  }

  const promptText = `Send one streaming inference request to provider ${state.providerAddress} (model: ${state.model}). This will spend a tiny amount of 0G from your sub-account. Continue?`;
  const ok = await confirmContinue(promptText);
  if (!ok) {
    console.log('[llm-probe-streaming] skipped by user.');
    return;
  }

  console.log(`[llm-probe-streaming] connecting to 0G ${state.network}…`);
  const signer = buildEnvPkZeroGSigner(key, state.network);
  const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: state.network });
  const client = new ZeroGLLMClient({
    broker,
    providerAddress: state.providerAddress,
    serviceUrl: state.serviceUrl,
    model: state.model,
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

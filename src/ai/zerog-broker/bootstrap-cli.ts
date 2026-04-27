import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadEnv } from '../../config/env';
import { buildZeroGBroker } from './zerog-broker-factory';
import { ZeroGBrokerService } from './zerog-broker-service';
import { ZeroGBootstrapStore } from './zerog-bootstrap-store';
import type { ZeroGBootstrapState } from './types';

const DEFAULT_LEDGER_OG = 3;       // 0G ledger minimum
const DEFAULT_TRANSFER_OG = 1;     // 0G per-provider minimum

function formatWeiAsOG(wei: bigint | undefined): string {
  if (wei === undefined) return '?';
  const og = Number(wei) / 1e18;
  return og.toFixed(8).replace(/\.?0+$/, '') || '0';
}

async function confirm(q: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { broker, walletAddress } = await buildZeroGBroker({
    WALLET_PRIVATE_KEY: env.WALLET_PRIVATE_KEY,
    ZEROG_NETWORK: env.ZEROG_NETWORK,
  });
  const service = new ZeroGBrokerService(broker);
  const store = new ZeroGBootstrapStore(env.DB_DIR);

  console.log(`[zerog-bootstrap] network=${env.ZEROG_NETWORK} wallet=${walletAddress}`);
  console.log(`[zerog-bootstrap] listing providers...`);

  const providers = await service.listProviders();
  if (providers.length === 0) {
    console.error('[zerog-bootstrap] no providers returned by listService()');
    process.exit(1);
  }

  console.log('');
  const modelFilter = process.env.ZEROG_MODEL_FILTER;
  const filterNote = modelFilter ? `  (model filter: "${modelFilter}")` : '';
  console.log(`Available chat providers (network=${env.ZEROG_NETWORK}${filterNote}):`);
  console.log('');
  for (const p of providers) {
    console.log(`  ${p.providerAddress}  model=${p.model}`);
    console.log(`    in: ${formatWeiAsOG(p.inputPricePerToken)} OG/token   out: ${formatWeiAsOG(p.outputPricePerToken)} OG/token`);
    console.log(`    sub-account balance: ${formatWeiAsOG(p.subAccountBalanceWei)} OG`);
    console.log(`    url=${p.serviceUrl}`);
  }
  console.log('');

  const target = process.env.ZEROG_PROVIDER_ADDRESS;
  if (!target) {
    console.log('[zerog-bootstrap] set ZEROG_PROVIDER_ADDRESS=<address> in .env, then re-run `npm run zerog-bootstrap` to fund + persist.');
    if (!modelFilter) {
      console.log('[zerog-bootstrap] tip: set ZEROG_MODEL_FILTER=<substring> to narrow the list (e.g. ZEROG_MODEL_FILTER=llama).');
    }
    return;
  }

  const chosen = providers.find((p) => p.providerAddress.toLowerCase() === target.toLowerCase());
  if (!chosen) {
    console.error(`[zerog-bootstrap] ZEROG_PROVIDER_ADDRESS=${target} not present in listService output.`);
    process.exit(1);
  }

  const ledgerOG = Number(process.env.ZEROG_LEDGER_OG ?? DEFAULT_LEDGER_OG);
  const transferOG = Number(process.env.ZEROG_TRANSFER_OG ?? DEFAULT_TRANSFER_OG);

  console.log(`[zerog-bootstrap] selected ${chosen.providerAddress} (${chosen.model})`);
  console.log(`[zerog-bootstrap] plan: addLedger(${ledgerOG} OG) (skipped if exists), then transferFund(${transferOG} OG) to provider sub-account, then acknowledge.`);

  const ok = await confirm(`Proceed? Total potential cost: ${ledgerOG} OG (only on first run; ${transferOG} OG on subsequent top-ups).`);
  if (!ok) {
    console.log('[zerog-bootstrap] cancelled.');
    return;
  }

  console.log('[zerog-bootstrap] funding + acknowledging...');
  const { serviceUrl, model } = await service.fundAndAcknowledge({
    providerAddress: chosen.providerAddress,
    ledgerInitialOG: ledgerOG,
    transferOG,
  });

  const now = Date.now();
  const state: ZeroGBootstrapState = {
    network: env.ZEROG_NETWORK,
    providerAddress: chosen.providerAddress,
    serviceUrl,
    model,
    acknowledgedAt: now,
    fundedAt: now,
    fundAmountOG: transferOG,
  };
  await store.save(state);

  console.log(`[zerog-bootstrap] persisted ${env.DB_DIR}/zerog-bootstrap.json`);
  console.log(`[zerog-bootstrap] next: run \`npm test\` to exercise the live LLM, or \`npm start\` to use it for agent ticks.`);
}

main().catch((err) => {
  console.error('[zerog-bootstrap] failed:', err);
  process.exit(1);
});

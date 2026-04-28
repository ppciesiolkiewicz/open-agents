import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadEnv } from '../../config/env';
import { buildZeroGBroker } from './zerog-broker-factory';
import { ZeroGBrokerService } from './zerog-broker-service';
import { ZeroGBootstrapStore } from './zerog-bootstrap-store';
import type { ZeroGBootstrapState } from './types';

const DEFAULT_LEDGER_OG = 3;       // 0G ledger minimum (each deposit unit)
const DEFAULT_TRANSFER_OG = 1;     // 0G per-provider minimum
const MIN_SUBACCOUNT_OG = 3;       // skip sub-account top-up if >= this (covers SDK's 2×MIN_LOCKED_BALANCE buffer + unsettledFee)
const MIN_LEDGER_OG = 3;           // keep this much in main ledger so SDK auto-funding can do several top-ups before draining

function formatWeiAsOG(wei: bigint | undefined): string {
  if (wei === undefined) return '?';
  const og = Number(wei) / 1e18;
  return og.toFixed(8).replace(/\.?0+$/, '') || '0';
}

function pricePerMillionOG(weiPerToken: bigint | undefined): string {
  if (weiPerToken === undefined) return '?';
  const ogPerMillion = (Number(weiPerToken) / 1e18) * 1_000_000;
  return ogPerMillion.toFixed(4).replace(/\.?0+$/, '') || '0';
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
    console.log(`    in: ${pricePerMillionOG(p.inputPricePerToken)} OG/1M tokens   out: ${pricePerMillionOG(p.outputPricePerToken)} OG/1M tokens`);
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

  const subBalanceWei = chosen.subAccountBalanceWei ?? 0n;
  const subBalanceOG = Number(subBalanceWei) / 1e18;
  const ledgerBalanceWei = await service.readLedgerAvailableBalanceWei();
  const ledgerBalanceOG = Number(ledgerBalanceWei) / 1e18;

  const willTopUpSub = subBalanceOG < MIN_SUBACCOUNT_OG;
  const willTopUpLedger = ledgerBalanceOG < MIN_LEDGER_OG;

  // Transfer enough to cross the threshold, clamped to the SDK's 1 OG minimum.
  const subDeficitOG = Math.max(0, MIN_SUBACCOUNT_OG - subBalanceOG);
  const transferOG = willTopUpSub
    ? Math.max(DEFAULT_TRANSFER_OG, Math.ceil(subDeficitOG))
    : DEFAULT_TRANSFER_OG;
  const ledgerOG = DEFAULT_LEDGER_OG;

  console.log(`[zerog-bootstrap] selected ${chosen.providerAddress} (${chosen.model})`);
  console.log(`[zerog-bootstrap] sub-account balance: ${formatWeiAsOG(subBalanceWei)} OG  (top-up threshold: ${MIN_SUBACCOUNT_OG} OG)`);
  console.log(`[zerog-bootstrap] main ledger available: ${formatWeiAsOG(ledgerBalanceWei)} OG  (top-up threshold: ${MIN_LEDGER_OG} OG — SDK auto-funding draws from here)`);

  const planLines: string[] = [];
  let costOG = 0;
  if (willTopUpSub) {
    planLines.push(`top up sub-account: transferFund(${transferOG} OG) from main ledger`);
    costOG += transferOG;
  }
  if (willTopUpLedger) {
    planLines.push(`top up main ledger: ${ledgerBalanceWei === 0n ? 'addLedger' : 'depositFund'}(${ledgerOG} OG)`);
    costOG += ledgerOG;
  }
  planLines.push(`acknowledge provider signer (idempotent)`);
  planLines.push(`persist db/zerog-bootstrap.json`);

  console.log('[zerog-bootstrap] plan:');
  for (const l of planLines) console.log(`  - ${l}`);

  const ok = await confirm(`Proceed? Estimated cost: ${costOG} OG.`);
  if (!ok) {
    console.log('[zerog-bootstrap] cancelled.');
    return;
  }

  console.log('[zerog-bootstrap] running…');
  const result = await service.fundAndAcknowledge({
    providerAddress: chosen.providerAddress,
    ledgerInitialOG: ledgerOG,
    transferOG,
    topUpThresholdOG: MIN_SUBACCOUNT_OG,
  });

  if (result.toppedUp) {
    console.log(`[zerog-bootstrap] sub-account topped up. balance: ${formatWeiAsOG(result.balanceBeforeWei)} OG → ${formatWeiAsOG(result.balanceAfterWei)} OG`);
  } else {
    console.log(`[zerog-bootstrap] sub-account: no top-up needed (balance ${formatWeiAsOG(result.balanceBeforeWei)} OG ≥ ${MIN_SUBACCOUNT_OG} OG).`);
  }

  const ledgerResult = await service.ensureLedgerBalance({
    minOG: MIN_LEDGER_OG,
    depositOG: ledgerOG,
  });
  if (ledgerResult.deposited) {
    console.log(`[zerog-bootstrap] main ledger funded. available: ${formatWeiAsOG(ledgerResult.balanceBeforeWei)} OG → ${formatWeiAsOG(ledgerResult.balanceAfterWei)} OG`);
  } else {
    console.log(`[zerog-bootstrap] main ledger: no top-up needed (available ${formatWeiAsOG(ledgerResult.balanceBeforeWei)} OG ≥ ${MIN_LEDGER_OG} OG).`);
  }

  const now = Date.now();
  const state: ZeroGBootstrapState = {
    network: env.ZEROG_NETWORK,
    providerAddress: chosen.providerAddress,
    serviceUrl: result.serviceUrl,
    model: result.model,
    acknowledgedAt: now,
    fundedAt: now,
    fundAmountOG:
      (result.toppedUp ? transferOG : 0) + (ledgerResult.deposited ? ledgerOG : 0),
  };
  await store.save(state);

  console.log(`[zerog-bootstrap] persisted ${env.DB_DIR}/zerog-bootstrap.json`);
  console.log(`[zerog-bootstrap] next: \`npm run llm:probe\` to sanity-check, or \`npm start\` to run the loop.`);
}

main().catch((err) => {
  console.error('[zerog-bootstrap] failed:', err);
  process.exit(1);
});

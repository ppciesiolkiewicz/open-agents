import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadEnv } from '../../config/env';
import { buildZeroGBroker, buildEnvPkZeroGSigner } from './zerog-broker-factory';
import { ZeroGBrokerService } from './zerog-broker-service';

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
  const signer = buildEnvPkZeroGSigner(env.WALLET_PRIVATE_KEY, env.ZEROG_NETWORK);
  const { broker, walletAddress } = await buildZeroGBroker({
    signer,
    ZEROG_NETWORK: env.ZEROG_NETWORK,
  });
  const service = new ZeroGBrokerService(broker);

  console.log(`[zerog-bootstrap] network=${env.ZEROG_NETWORK} wallet=${walletAddress}`);
  console.log('[zerog-bootstrap] note: 0G ledger funding for Privy wallets is handled via the UI flow, not this script.');
  console.log(`[zerog-bootstrap] listing providers...`);

  const providers = await service.listProviders();
  if (providers.length === 0) {
    console.error('[zerog-bootstrap] no providers returned by listService()');
    process.exit(1);
  }

  const ledgerExists = await service.hasLedger();
  const ledger = await service.readLedgerSnapshot();
  console.log('');
  if (!ledgerExists) {
    console.log(`Your 0G credit: NO LEDGER ACCOUNT YET on ${env.ZEROG_NETWORK}.`);
    console.log(`  → bootstrap will create one for you (addLedger ${DEFAULT_LEDGER_OG} OG) before any transfer.`);
  } else {
    console.log(`Your 0G credit:`);
    console.log(`  total owned:           ${formatWeiAsOG(ledger.totalWei)} OG  (main ledger + sub-accounts combined)`);
    console.log(`  main ledger available: ${formatWeiAsOG(ledger.availableWei)} OG  (free to transfer to a sub-account)`);
    console.log(`  locked in sub-accounts:${formatWeiAsOG(ledger.lockedWei)} OG  (sum across providers)`);
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

  const target = env.ZEROG_PROVIDER_ADDRESS;
  if (!target) {
    console.log('[zerog-bootstrap] no ZEROG_PROVIDER_ADDRESS set in .env. To select one and fund it:');
    console.log('  1. Pick an address from the list above.');
    console.log('  2. Set the following in .env:');
    console.log('       ZEROG_PROVIDER_ADDRESS=<address>');
    console.log('       ZEROG_SERVICE_URL=<url>');
    console.log('       ZEROG_MODEL=<model>');
    console.log('  3. Re-run `npm run zerog-bootstrap` to fund the sub-account.');
    if (!modelFilter) {
      console.log('[zerog-bootstrap] tip: set ZEROG_MODEL_FILTER=<substring> to narrow the list (e.g. ZEROG_MODEL_FILTER=llama).');
    }
    return;
  }

  const chosen = providers.find((p) => p.providerAddress.toLowerCase() === target.toLowerCase());
  if (!chosen) {
    console.error(`[zerog-bootstrap] ZEROG_PROVIDER_ADDRESS=${target} not present in listService output for network=${env.ZEROG_NETWORK}.`);
    console.error(`[zerog-bootstrap] check ZEROG_NETWORK matches the chain the provider is registered on, or pick a different provider from the list above.`);
    process.exit(1);
  }

  if (env.ZEROG_SERVICE_URL && env.ZEROG_SERVICE_URL !== chosen.serviceUrl) {
    console.warn(`[zerog-bootstrap] WARNING: env ZEROG_SERVICE_URL=${env.ZEROG_SERVICE_URL} differs from registry value ${chosen.serviceUrl}. Update .env if the registry value is correct.`);
  }
  if (env.ZEROG_MODEL && env.ZEROG_MODEL !== chosen.model) {
    console.warn(`[zerog-bootstrap] WARNING: env ZEROG_MODEL=${env.ZEROG_MODEL} differs from registry value ${chosen.model}. Update .env if the registry value is correct.`);
  }

  const subBalanceWei = chosen.subAccountBalanceWei ?? 0n;
  const subBalanceOG = Number(subBalanceWei) / 1e18;
  const ledgerBalanceWei = await service.readLedgerAvailableBalanceWei();
  const ledgerBalanceOG = Number(ledgerBalanceWei) / 1e18;

  const willTopUpSub = subBalanceOG < MIN_SUBACCOUNT_OG;

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
  let walletOutflowOG = 0;
  let projectedLedgerOG = ledgerBalanceOG;
  let ledgerCreated = ledgerExists;

  if (!ledgerCreated) {
    planLines.push(`addLedger(${ledgerOG} OG)  [wallet → ledger, creates ledger account on ${env.ZEROG_NETWORK}]`);
    walletOutflowOG += ledgerOG;
    projectedLedgerOG += ledgerOG;
    ledgerCreated = true;
  }

  if (willTopUpSub) {
    if (projectedLedgerOG < transferOG) {
      planLines.push(`depositFund(${ledgerOG} OG)  [wallet → ledger, funds upcoming transfer]`);
      walletOutflowOG += ledgerOG;
      projectedLedgerOG += ledgerOG;
    }
    planLines.push(`transferFund(${transferOG} OG)  [ledger → sub-account, internal — no wallet cost]`);
    projectedLedgerOG -= transferOG;
  }

  if (projectedLedgerOG < MIN_LEDGER_OG) {
    planLines.push(`depositFund(${ledgerOG} OG)  [wallet → ledger, keep main ≥ ${MIN_LEDGER_OG} OG for SDK auto-funding]`);
    walletOutflowOG += ledgerOG;
  }

  planLines.push(`acknowledge provider signer (idempotent — no wallet cost)`);

  console.log('[zerog-bootstrap] plan:');
  for (const l of planLines) console.log(`  - ${l}`);

  const ok = await confirm(`Proceed? Wallet outflow: ${walletOutflowOG} OG (deposits only; transfers are internal).`);
  if (!ok) {
    console.log('[zerog-bootstrap] cancelled.');
    return;
  }

  console.log('[zerog-bootstrap] running…');

  if (!ledgerExists) {
    console.log(`[zerog-bootstrap] no ledger on ${env.ZEROG_NETWORK} — creating with addLedger(${ledgerOG} OG)…`);
    await service.createLedger(ledgerOG);
    console.log(`[zerog-bootstrap] ledger created.`);
  }

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

  console.log('');
  console.log('[zerog-bootstrap] ✅ funded. Ensure these are set in .env (no file is persisted):');
  console.log(`  ZEROG_NETWORK=${env.ZEROG_NETWORK}`);
  console.log(`  ZEROG_PROVIDER_ADDRESS=${chosen.providerAddress}`);
  console.log(`  ZEROG_SERVICE_URL=${result.serviceUrl}`);
  console.log(`  ZEROG_MODEL=${result.model}`);
  console.log(`[zerog-bootstrap] next: \`npm run llm:probe\` to sanity-check, or \`npm start\` to run the loop.`);
}

main().catch((err) => {
  console.error('[zerog-bootstrap] failed:', err);
  process.exit(1);
});

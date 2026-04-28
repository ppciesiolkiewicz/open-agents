import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DryRunWallet } from './dry-run-wallet';
import { DRY_RUN_HASH_REGEX } from './dry-run-hash';
import { FileTransactionRepository } from '../../database/file-database/file-transaction-repository';
import { TOKENS } from '../../constants';
import type { AgentConfig, Transaction, TokenAmount } from '../../database/types';

// A throwaway wallet key — only used to derive an address; no private-key
// material from the user's .env touches this test.
const TEST_KEY = '0x' + '11'.repeat(32);

const usdc: TokenAmount = {
  tokenAddress: TOKENS.USDC.address,
  symbol: 'USDC',
  amountRaw: '100000000',           // 100 USDC (6 decimals)
  decimals: 6,
};

const uni: TokenAmount = {
  tokenAddress: TOKENS.UNI.address,
  symbol: 'UNI',
  amountRaw: '50000000000000000000', // 50 UNI (18 decimals)
  decimals: 18,
};

function makeAgent(id: string): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun: true,
    dryRunSeedBalances: {
      native: '1000000000000000000',                  // 1 ETH
      [TOKENS.USDC.address]: '1000000000',            // 1000 USDC
      [TOKENS.UNI.address]: '0',
    },
    riskLimits: { maxTradeUSD: 1_000, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

function makeSwapTx(id: string, agentId: string, tokenIn: TokenAmount, tokenOut: TokenAmount): Transaction {
  return {
    id,
    agentId,
    hash: `0x${'0'.repeat(60)}${id.padStart(4, '0')}`,
    chainId: 130,
    from: '0xabc',
    to: '0xdef',
    tokenIn,
    tokenOut,
    gasUsed: '200000',
    gasPriceWei: '1000000000',
    gasCostWei: '200000000000000',  // 200_000 * 1 gwei
    status: 'success',
    blockNumber: null,
    timestamp: Date.now(),
  };
}

describe('DryRunWallet (live, real FileTransactionRepository)', () => {
  let dbDir: string;
  let txRepo: FileTransactionRepository;
  let agent: AgentConfig;
  let wallet: DryRunWallet;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'agent-loop-wallet-'));
    txRepo = new FileTransactionRepository(dbDir);
    agent = makeAgent('a1');
    wallet = new DryRunWallet(agent, txRepo, { WALLET_PRIVATE_KEY: TEST_KEY });
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('derives a deterministic address from the private key', () => {
    const addr = wallet.getAddress();
    console.log('[dry-run-wallet] address:', addr);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('returns seeded balances when there are no transactions', async () => {
    const eth = await wallet.getNativeBalance();
    const usdcBal = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniBal = await wallet.getTokenBalance(TOKENS.UNI.address);
    console.log('[dry-run-wallet] seed balances — ETH:', eth, 'USDC:', usdcBal, 'UNI:', uniBal);
    expect(eth).toBe(1_000_000_000_000_000_000n);
    expect(usdcBal).toBe(1_000_000_000n);
    expect(uniBal).toBe(0n);
  });

  it('returns 0 for a token with no seed entry', async () => {
    const wbtc = '0x000000000000000000000000000000000000bbbb' as `0x${string}`;
    expect(await wallet.getTokenBalance(wbtc)).toBe(0n);
  });

  it('subtracts gas cost from native balance for each tx', async () => {
    await txRepo.insert(makeSwapTx('1', 'a1', usdc, uni));
    await txRepo.insert(makeSwapTx('2', 'a1', usdc, uni));

    const eth = await wallet.getNativeBalance();
    // seed 1 ETH minus 2 * 200_000 * 1 gwei = 1e18 - 4e14
    expect(eth).toBe(1_000_000_000_000_000_000n - 400_000_000_000_000n);
    console.log('[dry-run-wallet] native after 2 swaps (wei):', eth.toString());
  });

  it('updates token balances per tx (USDC out, UNI in)', async () => {
    await txRepo.insert(makeSwapTx('1', 'a1', usdc, uni));    // 100 USDC → 50 UNI

    const usdcBal = await wallet.getTokenBalance(TOKENS.USDC.address);
    const uniBal = await wallet.getTokenBalance(TOKENS.UNI.address);
    expect(usdcBal).toBe(1_000_000_000n - 100_000_000n);              // 900 USDC
    expect(uniBal).toBe(50_000_000_000_000_000_000n);                 // 50 UNI
    console.log('[dry-run-wallet] after 100 USDC → 50 UNI:', { usdcBal, uniBal });
  });

  it('isolates balances per agent (other agent\'s txs do not leak)', async () => {
    await txRepo.insert(makeSwapTx('1', 'someone-else', usdc, uni));
    const usdcBal = await wallet.getTokenBalance(TOKENS.USDC.address);
    expect(usdcBal).toBe(1_000_000_000n);  // unchanged
  });

  it('signAndSendTransaction returns a receipt with the sentinel hash', async () => {
    const receipt = await wallet.signAndSendTransaction({
      to: '0x000000000000000000000000000000000000dead' as `0x${string}`,
      gas: 250_000n,
      gasPriceWei: 2_000_000_000n,
    });
    console.log('[dry-run-wallet] synthetic receipt:', {
      hash: receipt.transactionHash,
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
    });
    expect(receipt.transactionHash).toMatch(DRY_RUN_HASH_REGEX);
    expect(receipt.status).toBe('success');
    expect(receipt.blockNumber).toBe(0n);
    expect(receipt.gasUsed).toBe(250_000n);
    expect(receipt.effectiveGasPrice).toBe(2_000_000_000n);
    expect(receipt.from).toBe(wallet.getAddress());
    expect(receipt.to).toBe('0x000000000000000000000000000000000000dead');
  });

  it('signAndSendTransaction falls back to default gas + price when not provided', async () => {
    const receipt = await wallet.signAndSendTransaction({
      to: '0x000000000000000000000000000000000000dead' as `0x${string}`,
    });
    expect(receipt.gasUsed).toBe(200_000n);              // DEFAULT_DRY_RUN_GAS
    expect(receipt.effectiveGasPrice).toBe(1_000_000_000n); // DEFAULT_DRY_RUN_GAS_PRICE_WEI
  });
});

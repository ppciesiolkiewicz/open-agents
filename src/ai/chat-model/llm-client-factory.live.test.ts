import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { JsonRpcProvider } from 'ethers';
import { createPublicClient, http } from 'viem';
import { unichain } from 'viem/chains';
import { LLMClientFactory } from './llm-client-factory';
import { StubLLMClient } from '../../agent-runner/stub-llm-client';
import { WalletFactory } from '../../wallet/factory/wallet-factory';
import { PrismaTransactionRepository } from '../../database/prisma-database/prisma-transaction-repository';
import { PrismaUserWalletRepository } from '../../database/prisma-database/prisma-user-wallet-repository';
import { getTestPrisma, truncateAll } from '../../database/prisma-database/test-helpers';
import { ZEROG_NETWORKS } from '../../constants';
import type { AgentConfig } from '../../database/types';
import type { ZeroGBootstrapState } from '../zerog-broker/types';

const TEST_KEY = '0x' + '11'.repeat(32);
const TEST_ENV = { WALLET_PRIVATE_KEY: TEST_KEY, ALCHEMY_API_KEY: 'unused' };
const PUBLIC_CLIENT = createPublicClient({ chain: unichain, transport: http() });
const ZEROG_PROVIDER = new JsonRpcProvider(ZEROG_NETWORKS.testnet.rpcUrl);

function makeAgent(id: string, userId: string): AgentConfig {
  return {
    id,
    userId,
    name: id,
    running: true,
    intervalMs: 60_000,
    prompt: 'test',
    dryRun: false,
    allowedTokens: [],
    riskLimits: { maxTradeUSD: 100, maxSlippageBps: 100 },
    lastTickAt: null,
    createdAt: Date.now(),
  };
}

const FAKE_BOOTSTRAP: ZeroGBootstrapState = {
  network: 'testnet',
  providerAddress: '0xf07240Efa67755B5311bc75784a061eDB47165Dd',
  serviceUrl: 'https://example.invalid/v1/proxy',
  model: 'llama-3.3-70b-instruct',
  acknowledgedAt: 1,
  fundedAt: 1,
  fundAmountOG: 0,
};

describe('LLMClientFactory (live)', () => {
  const prisma = getTestPrisma();

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  function buildWallet(): WalletFactory {
    return new WalletFactory({
      env: TEST_ENV,
      walletMode: 'pk',
      transactions: new PrismaTransactionRepository(prisma),
      userWallets: new PrismaUserWalletRepository(prisma),
      privy: null,
      publicClient: PUBLIC_CLIENT,
      zerogProvider: ZEROG_PROVIDER,
      zerogChainId: ZEROG_NETWORKS.testnet.chainId,
    });
  }

  it('returns StubLLMClient when bootstrap state is null', async () => {
    const llmFactory = new LLMClientFactory(buildWallet(), null);
    const llm = await llmFactory.forAgent(makeAgent('a1', 'u1'));
    expect(llm).toBeInstanceOf(StubLLMClient);
  });

  it('caches one LLMClient per signer address (pk singleton → same instance for two agents)', async () => {
    const llmFactory = new LLMClientFactory(buildWallet(), FAKE_BOOTSTRAP);
    const a = await llmFactory.forAgent(makeAgent('a1', 'u1'));
    const b = await llmFactory.forAgent(makeAgent('a2', 'u2'));
    expect(a).toBe(b);
    console.log('[llm-factory] pk singleton cached across users:', a.modelName());
  });

  it('modelName reflects bootstrap state', () => {
    const llmFactory = new LLMClientFactory(buildWallet(), FAKE_BOOTSTRAP);
    expect(llmFactory.modelName()).toBe(FAKE_BOOTSTRAP.model);
  });
});

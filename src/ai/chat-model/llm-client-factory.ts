import type { LLMClient } from '../../agent-runner/llm-client';
import type { AgentConfig } from '../../database/types';
import type { WalletFactory } from '../../wallet/factory/wallet-factory';
import type { ZeroGBootstrapState } from '../zerog-broker/types';
import { buildZeroGBroker } from '../zerog-broker/zerog-broker-factory';
import { ZeroGLLMClient } from './zerog-llm-client';
import { StubLLMClient } from '../../agent-runner/stub-llm-client';

export class LLMClientFactory {
  private readonly cache = new Map<string, Promise<LLMClient>>();
  private readonly stub: LLMClient | null;

  constructor(
    private readonly walletFactory: WalletFactory,
    private readonly bootstrapState: ZeroGBootstrapState | null,
  ) {
    this.stub = bootstrapState ? null : new StubLLMClient();
  }

  modelName(): string {
    return this.bootstrapState?.model ?? new StubLLMClient().modelName();
  }

  async forAgent(agent: AgentConfig): Promise<LLMClient> {
    if (this.stub) return this.stub;
    const handle = await this.walletFactory.forZerogPayments(agent);
    const cached = this.cache.get(handle.address);
    if (cached) return cached;
    const promise = this.build(handle.signer);
    this.cache.set(handle.address, promise);
    return promise;
  }

  private async build(signer: Awaited<ReturnType<WalletFactory['forZerogPayments']>>['signer']): Promise<LLMClient> {
    const state = this.bootstrapState!;
    const { broker } = await buildZeroGBroker({ signer, ZEROG_NETWORK: state.network });
    return new ZeroGLLMClient({
      broker,
      providerAddress: state.providerAddress,
      serviceUrl: state.serviceUrl,
      model: state.model,
    });
  }
}

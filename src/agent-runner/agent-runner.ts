import type { Database } from '../database/database';
import type { AgentConfig, AgentMemory } from '../database/types';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import type { WalletFactory } from '../wallet/factory/wallet-factory';
import type { LLMClient } from './llm-client';

export interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export class AgentRunner {
  constructor(
    private readonly db: Database,
    private readonly activityLog: AgentActivityLog,
    private readonly walletFactory: WalletFactory,
    private readonly llm: LLMClient,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async run(agent: AgentConfig): Promise<void> {
    const tickId = `${agent.id}-${this.clock.now()}`;
    await this.activityLog.tickStart(agent.id, tickId);

    try {
      const memory = await this.loadOrInitMemory(agent.id);
      // Wallet is constructed (cached by factory) but not yet exposed to the
      // LLM as tools — slice 6 wires balance/swap tools.
      this.walletFactory.forAgent(agent);

      const prompt = this.buildPrompt(agent, memory);
      await this.activityLog.llmCall(agent.id, tickId, {
        model: this.llm.modelName(),
        promptChars: prompt.length,
      });

      const response = await this.llm.invoke(prompt);
      await this.activityLog.llmResponse(agent.id, tickId, {
        model: this.llm.modelName(),
        responseChars: response.content.length,
      });

      await this.activityLog.tickEnd(agent.id, tickId, {
        ok: true,
        responseChars: response.content.length,
      });
    } catch (err) {
      const e = err as Error;
      await this.activityLog.error(agent.id, tickId, {
        message: e.message,
        stack: e.stack,
      });
      await this.activityLog.tickEnd(agent.id, tickId, { ok: false });
      // Do NOT rethrow — orchestrator continues with the next agent.
    } finally {
      // Skip-backlog invariant: lastTickAt updates on success AND failure.
      await this.db.agents.upsert({ ...agent, lastTickAt: this.clock.now() });
    }
  }

  private buildPrompt(agent: AgentConfig, memory: AgentMemory): string {
    return [
      agent.prompt,
      '',
      'Memory state:',
      JSON.stringify(memory.state, null, 2),
      '',
      'Memory notes:',
      memory.notes || '(empty)',
    ].join('\n');
  }

  private async loadOrInitMemory(agentId: string): Promise<AgentMemory> {
    const existing = await this.db.agentMemory.get(agentId);
    if (existing) return existing;
    return {
      agentId,
      notes: '',
      state: {},
      updatedAt: this.clock.now(),
    };
  }
}

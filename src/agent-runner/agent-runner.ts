import type { Database } from '../database/database';
import type { AgentConfig, AgentMemory } from '../database/types';
import type { AgentActivityLog } from '../agent-activity-log/agent-activity-log';
import type { WalletFactory } from '../wallet/factory/wallet-factory';
import type { ToolRegistry } from '../ai-tools/tool-registry';
import type { AgentTool, AgentToolContext } from '../ai-tools/tool';
import { toToolDefinition } from '../ai-tools/zod-to-openai';
import { AGENT_RUNNER } from '../constants';
import type { ChatMessage, LLMClient, ToolCall } from './llm-client';

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
    private readonly toolRegistry: ToolRegistry,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  async run(agent: AgentConfig): Promise<void> {
    const tickId = `${agent.id}-${this.clock.now()}`;

    try {
      await this.activityLog.tickStart(agent.id, tickId);

      const wallet = this.walletFactory.forAgent(agent);
      const tools = this.toolRegistry.build();
      const toolByName = new Map(tools.map((t) => [t.name, t]));
      const toolDefs = tools.map(toToolDefinition);

      const memory = await this.loadOrInitMemory(agent.id);
      const ctx: AgentToolContext = { agent, wallet, tickId };

      const messages: ChatMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(agent, memory) },
        { role: 'user', content: 'Run one tick.' },
      ];

      let rounds = 0;
      while (rounds < AGENT_RUNNER.maxToolRoundsPerTick) {
        rounds++;
        const promptChars = messages.reduce((sum, m) => sum + this.messageChars(m), 0);
        await this.activityLog.llmCall(agent.id, tickId, {
          model: this.llm.modelName(),
          promptChars,
        });

        const turn = await this.llm.invokeWithTools(messages, toolDefs);

        await this.activityLog.llmResponse(agent.id, tickId, {
          model: this.llm.modelName(),
          responseChars: (turn.content ?? '').length,
          ...(turn.tokenCount !== undefined ? { tokenCount: turn.tokenCount } : {}),
        });

        messages.push(turn.assistantMessage);

        if (!turn.toolCalls || turn.toolCalls.length === 0) {
          // No more tool work — model is done.
          await this.activityLog.tickEnd(agent.id, tickId, {
            ok: true,
            rounds,
            responseChars: (turn.content ?? '').length,
          });
          return;
        }

        // Dispatch each tool call, collect tool reply messages.
        for (const call of turn.toolCalls) {
          const reply = await this.dispatchToolCall(agent.id, tickId, call, toolByName, ctx);
          messages.push(reply);
        }
      }

      // Hit the round cap without the model returning plain text.
      await this.activityLog.error(agent.id, tickId, {
        message: `exceeded ${AGENT_RUNNER.maxToolRoundsPerTick} tool-call rounds`,
      });
      await this.activityLog.tickEnd(agent.id, tickId, { ok: false, rounds });
    } catch (err) {
      const e = err as Error;
      try {
        await this.activityLog.error(agent.id, tickId, {
          message: e.message,
          stack: e.stack,
        });
        await this.activityLog.tickEnd(agent.id, tickId, { ok: false });
      } catch {
        // intentionally ignored — never rethrow
      }
    } finally {
      await this.db.agents.upsert({ ...agent, lastTickAt: this.clock.now() });
    }
  }

  private async dispatchToolCall(
    agentId: string,
    tickId: string,
    call: ToolCall,
    toolByName: Map<string, AgentTool>,
    ctx: AgentToolContext,
  ): Promise<ChatMessage> {
    const tool = toolByName.get(call.name);
    if (!tool) {
      const errMsg = `unknown tool: ${call.name}`;
      await this.activityLog.toolCall(agentId, tickId, { tool: call.name, input: call.argumentsJson });
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }

    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(JSON.parse(call.argumentsJson));
    } catch (err) {
      const errMsg = `invalid tool input: ${(err as Error).message}`;
      await this.activityLog.toolCall(agentId, tickId, { tool: call.name, input: call.argumentsJson });
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }

    await this.activityLog.toolCall(agentId, tickId, { tool: call.name, input: parsed });
    const start = this.clock.now();
    try {
      const output = await tool.invoke(parsed, ctx);
      const durationMs = this.clock.now() - start;
      await this.activityLog.toolResult(agentId, tickId, {
        tool: call.name,
        output,
        durationMs,
      });
      return { role: 'tool', toolCallId: call.id, content: JSON.stringify(output) };
    } catch (err) {
      const errMsg = (err as Error).message;
      const durationMs = this.clock.now() - start;
      await this.activityLog.error(agentId, tickId, { tool: call.name, message: errMsg });
      await this.activityLog.toolResult(agentId, tickId, {
        tool: call.name,
        output: `error: ${errMsg}`,
        durationMs,
      });
      return { role: 'tool', toolCallId: call.id, content: `error: ${errMsg}` };
    }
  }

  private buildSystemPrompt(agent: AgentConfig, memory: AgentMemory): string {
    return [
      agent.prompt,
      '',
      'You have tools available — see the function-calling schema. Use them to gather information.',
      'Use saveMemoryEntry at the end of each tick to record what you learned and what you decided. Use updateMemory to overwrite your structured state when it changes.',
      '',
      'Current memory state:',
      JSON.stringify(memory.state, null, 2),
      '',
      'Current memory notes:',
      memory.notes || '(empty)',
      '',
      `Recent memory entries (last ${Math.min(5, memory.entries.length)}):`,
      memory.entries.length === 0
        ? '(none yet)'
        : JSON.stringify(memory.entries.slice(-5), null, 2),
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
      entries: [],
    };
  }

  private messageChars(m: ChatMessage): number {
    if (m.role === 'tool') return m.content.length;
    if (m.role === 'assistant') return m.content.length;
    return m.content.length;
  }
}
